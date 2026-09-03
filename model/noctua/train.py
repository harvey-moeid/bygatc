"""
noctua/train.py
=====================================================================
Stage 5b: fit NOCTUA, then calibrate it.

Training uses the multi-anchor augmentation (RESEARCH_PLAN section 3.4): all 24
anchor hours and all four horizons, ~190k episodes instead of the ~2k native
17:00/19h episodes. The clock and the horizon are conditioning inputs, so the
production slice is one well-estimated slice of a shared surface rather than a
separately-fitted model starved of data.

Reported numbers always come from the production slice only.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from . import baselines as B
from . import infer as I
from . import splits as S
from .calibrate import NoctuaCalibration
from .model import BASE_COLS, LEVELS, SHAPE_COLS, Noctua, coupling_penalty, pinball_loss
from .spec import NON_MODEL_COLS

EPS = 1e-12


# --------------------------------------------------------------------------
def load_all(artifacts: Path):
    ep = pd.read_parquet(artifacts / "episodes.parquet")
    X = pd.read_parquet(artifacts / "features.parquet")
    return ep, X


class Standardizer:
    """z-scoring fitted on the training split only."""

    def __init__(self):
        self.mu = None
        self.sd = None

    def fit(self, A: np.ndarray):
        self.mu = np.nanmean(A, axis=0)
        self.sd = np.nanstd(A, axis=0)
        self.sd = np.where(self.sd < 1e-8, 1.0, self.sd)
        return self

    def __call__(self, A: np.ndarray) -> np.ndarray:
        return np.nan_to_num((A - self.mu) / self.sd, nan=0.0, posinf=0.0, neginf=0.0)


def prepare(ep, X, mask, std_all=None, std_shape=None, std_base=None,
            shape_cols=None, sigma_ref=None):
    """Slice + standardize the three input blocks and build targets.

    `shape_cols` overrides the stage-B column list. It exists for the ablation
    in eval/efficiency.py: an arm that is meant not to see a feature must not
    see it in the wide block either, so the override drops those columns from
    BOTH Xs and Xa. Passing the same columns a second time through a different
    input would have made the ablation measure nothing.
    """
    shape_cols = list(SHAPE_COLS if shape_cols is None else shape_cols)
    # Anything the model must not consume, minus whatever this arm explicitly
    # asked for. NON_MODEL_COLS is what keeps a research column in
    # features.parquet from silently widening Xa and changing the artifact.
    dropped = [c for c in set(SHAPE_COLS) | set(NON_MODEL_COLS)
               if c not in shape_cols]
    all_cols = [c for c in X.columns if c not in dropped]

    Xa = X.loc[mask, all_cols].to_numpy(np.float64)
    Xb = X.loc[mask, BASE_COLS].to_numpy(np.float64)
    Xs = X.loc[mask, shape_cols].to_numpy(np.float64)

    e = ep.loc[mask]
    H = e["H"].to_numpy(np.float64)
    RV = e["RV"].to_numpy(np.float64)
    y = B.har_target(RV, H)                       # log hourly vol rate

    # THE SCALE STAGE B IS TRAINED AGAINST.
    #
    # Default is RV, the REALIZED window volatility, and that is a train/serve
    # skew rather than a convenience. Stage B learns quantiles of M_up/sigma
    # conditioned on log sigma; at serving `sigma` is the model's own FORECAST,
    # so the target it was fitted to is not the target it faces. Dividing by
    # the realized value quietly removes the volatility-forecast error from the
    # problem. Measured on the production slice:
    #
    #   sd( M_up / RV_true    ) = 0.5490   <- what training fits
    #   sd( M_up / sigma_hat  ) = 0.9312   <- what serving faces, 1.7x wider
    #
    # It also manufactures dependence: RV appears in the denominator of the
    # target AND in the conditioner, so noise in RV alone produces Spearman
    # -0.4331 between them (verified by permuting RV, which destroys every
    # economic relationship and leaves the correlation nearly intact). That is
    # Pearson's spurious correlation of ratios, and stage B is free to fit it.
    #
    # Passing `sigma_ref` makes the training target the one serving actually
    # uses. What ships is exp(har_1d)*sqrt(H) -- a FEATURE, so nothing is
    # fitted and nothing can leak -- clipped to the training episodes' range.
    # NOT a cross-fitted estimator: that version used ordinary K-fold, which
    # fits each held-out block on later blocks too, and was discarded.
    sigma = RV if sigma_ref is None else np.asarray(sigma_ref, np.float64)
    r = e["R"].to_numpy(np.float64) / np.maximum(sigma, EPS)
    m_up = e["M_up"].to_numpy(np.float64) / np.maximum(sigma, EPS)
    m_dn = -e["M_dn"].to_numpy(np.float64) / np.maximum(sigma, EPS)

    if std_all is None:
        std_all, std_shape, std_base = Standardizer().fit(Xa), Standardizer().fit(Xs), Standardizer().fit(Xb)

    return dict(
        # The columns ACTUALLY consumed, so callers record the model's real
        # input rather than assuming it equals features.parquet's columns.
        # train_v2 stored `list(X.columns)` as feat_cols, which was correct
        # only while every column in the frame was a model input. Adding one
        # research column (eff_*) made the artifact's metadata disagree with
        # its own weight shapes -- 42 declared against 39 trained -- and
        # serving failed with a matmul dimension error.
        cols=dict(all=list(all_cols), base=list(BASE_COLS), shape=list(shape_cols)),
        Xa=std_all(Xa).astype(np.float32),
        Xb=std_base(Xb).astype(np.float32),
        Xs=std_shape(Xs).astype(np.float32),
        Xb_raw=np.nan_to_num(Xb).astype(np.float64),
        y=y.astype(np.float32),
        log_sigma=np.log(np.maximum(sigma, EPS)).astype(np.float32),
        r=r.astype(np.float32),
        m_up=m_up.astype(np.float32),
        m_dn=m_dn.astype(np.float32),
        H=H, RV=RV,
    ), (std_all, std_shape, std_base)


# --------------------------------------------------------------------------
def train_model(
    tr, wtr, va, *, hidden=128, epochs=40, bs=4096, lr=2e-3, lam_couple=1.0,
    lam_anchor=0.0, seed=0, verbose=True, ols_beta=None,
):
    torch.manual_seed(seed)
    np.random.seed(seed)

    model = Noctua(tr["Xa"].shape[1], tr["Xb"].shape[1], tr["Xs"].shape[1], hidden)
    if ols_beta is not None:
        model.a.init_base_from_ols(ols_beta)

    dev = torch.device("cpu")
    lv = torch.tensor(LEVELS, dtype=torch.float32, device=dev)

    T = {k: torch.tensor(v, device=dev) for k, v in tr.items()
         if k in ("Xa", "Xb", "Xs", "y", "log_sigma", "r", "m_up", "m_dn")}
    W = torch.tensor(wtr.astype(np.float32), device=dev)
    V = {k: torch.tensor(v, device=dev) for k, v in va.items()
         if k in ("Xa", "Xb", "Xs", "y", "log_sigma", "r", "m_up", "m_dn")}

    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    n = len(T["y"])
    steps = max(1, n // bs)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=epochs * steps)

    best, best_state, bad = np.inf, None, 0
    for ep_i in range(epochs):
        model.train()
        perm = torch.randperm(n)
        tot = 0.0
        for i in range(steps):
            idx = perm[i * bs : (i + 1) * bs]
            qa, res_med = model.a(T["Xa"][idx], T["Xb"][idx], return_parts=True)
            qr, qu, qd = model.b(T["Xs"][idx], T["log_sigma"][idx][:, None])

            loss = (
                pinball_loss(qa, T["y"][idx], lv, W[idx])
                + lam_anchor * (res_med**2).mean()
                + pinball_loss(qr, T["r"][idx], lv, W[idx])
                + pinball_loss(qu, T["m_up"][idx], lv, W[idx])
                + pinball_loss(qd, T["m_dn"][idx], lv, W[idx])
                + lam_couple * coupling_penalty(qr, qu, qd)
            )
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()
            sched.step()
            tot += float(loss)

        model.eval()
        with torch.no_grad():
            qa = model.a(V["Xa"], V["Xb"])
            qr, qu, qd = model.b(V["Xs"], V["log_sigma"][:, None])
            vl = float(
                pinball_loss(qa, V["y"], lv)
                + pinball_loss(qr, V["r"], lv)
                + pinball_loss(qu, V["m_up"], lv)
                + pinball_loss(qd, V["m_dn"], lv)
            )
        if verbose and (ep_i % 5 == 0 or ep_i == epochs - 1):
            print(f"  epoch {ep_i:3d}  train {tot/steps:.5f}  val {vl:.5f}")
        if vl < best - 1e-5:
            best, bad = vl, 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        else:
            bad += 1
            if bad >= 8:
                if verbose:
                    print(f"  early stop at epoch {ep_i} (best val {best:.5f})")
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    return model, best


# --------------------------------------------------------------------------
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Train NOCTUA")
    p.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--hidden", type=int, default=128)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=Path, default=Path("model/artifacts/noctua.pt"))
    a = p.parse_args(argv)

    ep, X = load_all(a.artifacts)
    fin = np.isfinite(X.to_numpy()).all(1)
    sp = S.time_splits(ep)
    m_tr, m_va = sp["train"] & fin, sp["calib"] & fin

    print(f"[train] train={int(m_tr.sum())}  calib={int(m_va.sum())}")

    tr, stds = prepare(ep, X, m_tr)
    va, _ = prepare(ep, X, m_va, *stds)
    wtr = S.sample_weights(ep, m_tr)

    # Seed Stage A's linear base at the Log-HAR OLS solution. Fitted on the
    # STANDARDIZED columns, because those are what the network actually sees.
    Xb_std = pd.DataFrame(tr["Xb"], columns=BASE_COLS)
    ols_std = B.OLS(BASE_COLS).fit(Xb_std, tr["y"].astype(np.float64), wtr)

    t0 = time.time()
    model, best = train_model(
        tr, wtr, va, hidden=a.hidden, epochs=a.epochs, seed=a.seed, ols_beta=ols_std.beta
    )
    dt = time.time() - t0

    # ---- Stage C: fit the recalibration layer on the held-out calib split ----
    # H=19 only, but ALL anchor hours, so the PIT maps are estimated on ~13k
    # episodes rather than the ~550 native production ones.
    m_cal19 = m_va & (ep.H == 19).to_numpy()
    cal_d, _ = prepare(ep, X, m_cal19, *stds)
    pc = I.predict(model, cal_d)
    e_cal = ep[m_cal19]
    calib = NoctuaCalibration().fit(
        pc, e_cal.M_up.to_numpy(), e_cal.M_dn.to_numpy(), e_cal.R.to_numpy()
    )
    print(f"[train] calibration fitted on {int(m_cal19.sum())} episodes")

    a.out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "state_dict": model.state_dict(),
            "hidden": a.hidden,
            "n_feat": tr["Xa"].shape[1],
            "n_base": tr["Xb"].shape[1],
            "n_shape": tr["Xs"].shape[1],
            "feat_cols": list(X.columns),
            "base_cols": BASE_COLS,
            "shape_cols": SHAPE_COLS,
            "levels": LEVELS,
            "std_all": (stds[0].mu, stds[0].sd),
            "std_shape": (stds[1].mu, stds[1].sd),
            "std_base": (stds[2].mu, stds[2].sd),
            "calibration": calib.to_dict(),
            "har_beta": ols_std.beta,
            "blend_w": I.BLEND_W,
        },
        a.out,
    )
    print(json.dumps({
        "params": model.n_params(),
        "val_pinball": round(best, 6),
        "train_seconds": round(dt, 1),
        "artifact_kb": round(a.out.stat().st_size / 1024, 1),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
