"""
noctua/evaluate.py
=====================================================================
Stage 6: the out-of-sample scoreboard.

Reported on the PRODUCTION SLICE only -- H = 19h, anchor 17:00 UTC, one episode
per calendar day -- because that is the trade the user actually makes and
because significance computed on overlapping windows is an illusion.

Sections:
  1. Volatility      vs Log-HAR and the rest of the HAR family (QLIKE, R2)
  2. Barrier         calibration of the touch probabilities -- the headline,
                     since a seller sizes positions on these numbers
  3. Direction       log-loss / Brier vs a constant
  4. Distribution    CRPS / pinball on the terminal return
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from scipy.stats import norm

from . import baselines as B
from . import infer as I
from . import splits as S
from .calibrate import NoctuaCalibration
from .model import Noctua
from .train import Standardizer, load_all, prepare

ALPHAS = np.array([0.01, 0.02, 0.05, 0.10, 0.20, 0.30])
RET_LEVELS = np.array([0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95])


# --------------------------------------------------------------------------
def load_model(path: Path):
    ck = torch.load(path, weights_only=False)
    m = Noctua(ck["n_feat"], ck["n_base"], ck["n_shape"], ck["hidden"])
    m.load_state_dict(ck["state_dict"])
    m.eval()
    return m, ck


def stds_from_ck(ck):
    out = []
    for key in ("std_all", "std_shape", "std_base"):
        s = Standardizer()
        s.mu, s.sd = ck[key]
        out.append(s)
    return tuple(out)


# --------------------------------------------------------------------------
def block_bootstrap_pvalue(d: np.ndarray, block: int = 10, n_boot: int = 5000,
                           seed: int = 0) -> float:
    """Two-sided p-value that mean(d) == 0, via a moving-block bootstrap.

    `d` is the per-episode loss DIFFERENCE (baseline - model), so a positive
    mean favours the model. Blocks preserve the serial dependence that
    volatility clustering guarantees; an iid bootstrap would badly overstate
    significance here.
    """
    rng = np.random.default_rng(seed)
    n = len(d)
    if n < block * 3:
        return float("nan")
    n_blocks = int(np.ceil(n / block))
    obs = float(d.mean())
    dc = d - obs                      # centre under H0
    starts = rng.integers(0, n - block + 1, size=(n_boot, n_blocks))
    take = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(n_boot, -1)[:, :n]
    boot = dc[take].mean(axis=1)
    return float(np.mean(np.abs(boot) >= abs(obs)))


# --------------------------------------------------------------------------
def volatility_section(ep, X, m_tr, m_te, pred, wtr):
    H = ep.H.to_numpy(np.float64)
    y = B.har_target(ep.RV.to_numpy(), H)
    rv_te, H_te, y_te = ep.RV.to_numpy()[m_te], H[m_te], y[m_te]

    models = B.fit_vol_baselines(X[m_tr], y[m_tr], wtr)
    rows, losses = [], {}

    def add(name, logpred):
        pv = (np.exp(logpred) * np.sqrt(H_te)) ** 2
        r = np.maximum(rv_te**2, 1e-18) / np.maximum(pv, 1e-18)
        per = r - np.log(r) - 1.0                     # per-episode QLIKE
        losses[name] = per
        rows.append({
            "model": name,
            "QLIKE": float(per.mean()),
            "MSE_log": B.mse_log(logpred, y_te),
            "R2_log": B.r2_log(logpred, y_te),
        })

    for name, m in models.items():
        add(name, m.predict(X[m_te]))
    cols = ("har_1d", "har_5d", "har_22d")
    e_te = B.ewma_vol(*[X[c].to_numpy()[m_te] for c in cols])
    e_tr = B.ewma_vol(*[X[c].to_numpy()[m_tr] for c in cols])
    add("ewma", e_te + float((y[m_tr] - e_tr).mean()))

    # NOCTUA: median of Stage A's predictive distribution
    add("NOCTUA", np.log(pred["sigma_med"]) - 0.5 * np.log(H_te))

    df = pd.DataFrame(rows).sort_values("QLIKE", ignore_index=True)
    ref = "log_har_cal"
    df["vs_ref_pct"] = 100.0 * (df.QLIKE / float(np.mean(losses[ref])) - 1.0)
    df["p_vs_ref"] = [
        np.nan if n == ref else block_bootstrap_pvalue(losses[ref] - losses[n])
        for n in df.model
    ]
    return df, losses


# --------------------------------------------------------------------------
def barrier_section(ep, X, m_tr, m_te, pred, calib=None, alphas=ALPHAS):
    """The headline.

    For each target alpha the model names a level it claims breaks only alpha
    of the time; we then count how often it actually broke. A perfectly
    calibrated model lands on the diagonal. Discrimination is worthless to a
    seller if this column is wrong.
    """
    M_up = ep.M_up.to_numpy()[m_te]
    M_dn = -ep.M_dn.to_numpy()[m_te]

    H = ep.H.to_numpy(np.float64)
    y = B.har_target(ep.RV.to_numpy(), H)
    har = B.fit_vol_baselines(X[m_tr], y[m_tr])["log_har_cal"]
    sig_har = np.exp(har.predict(X[m_te])) * np.sqrt(H[m_te])

    emp = B.EmpiricalExcursion().fit(
        ep.M_up.to_numpy()[m_tr], ep.M_dn.to_numpy()[m_tr], ep.RV.to_numpy()[m_tr]
    )

    rows = []
    for a in alphas:
        u_n = I.safe_level(pred, a, up=True)
        l_n = I.safe_level(pred, a, up=False)
        # Gaussian reflection: invert 2*Phi(-u/sigma) = alpha
        u_g = -sig_har * norm.ppf(a / 2.0)
        # empirical: the standardized level whose historical survival is alpha
        z_e = float(np.interp(-a, -emp.surv_up, emp.grid))
        z_d = float(np.interp(-a, -emp.surv_dn, emp.grid))
        row = {
            "alpha": float(a),
            "NOCTUA_up": float((M_up >= u_n).mean()),
            "NOCTUA_dn": float((M_dn >= l_n).mean()),
            "gauss_up": float((M_up >= u_g).mean()),
            "gauss_dn": float((M_dn >= u_g).mean()),
            "emp_up": float((M_up >= z_e * sig_har).mean()),
            "emp_dn": float((M_dn >= z_d * sig_har).mean()),
            "NOCTUA_lvl_up%": float(100 * np.median(u_n)),
            "NOCTUA_lvl_dn%": float(100 * np.median(l_n)),
            "gauss_lvl%": float(100 * np.median(u_g)),
        }
        if calib is not None:
            u_c = calib.safe_level(pred, a, up=True)
            l_c = calib.safe_level(pred, a, up=False)
            row["CAL_up"] = float((M_up >= u_c).mean())
            row["CAL_dn"] = float((M_dn >= l_c).mean())
            row["CAL_lvl_up%"] = float(100 * np.median(u_c))
            row["CAL_lvl_dn%"] = float(100 * np.median(l_c))
        rows.append(row)
    df = pd.DataFrame(rows)
    pairs = [("NOCTUA", "NOCTUA_up", "NOCTUA_dn"),
             ("gauss", "gauss_up", "gauss_dn"),
             ("emp", "emp_up", "emp_dn")]
    if calib is not None:
        pairs.append(("CAL", "CAL_up", "CAL_dn"))
    for c, u, d in pairs:
        df[c + "_err_pp"] = 100 * 0.5 * ((df[u] - df.alpha).abs() + (df[d] - df.alpha).abs())
    return df


# --------------------------------------------------------------------------
def direction_section(ep, m_te, pred):
    R = ep.R.to_numpy()[m_te]
    up = (R > 0).astype(np.float64)
    p = I.prob_up(pred)
    base = np.full_like(p, 0.5)
    return pd.DataFrame([
        {"model": "NOCTUA", "log_loss": B.log_loss(p, up), "brier": B.brier(p, up),
         "mean_p_up": float(p.mean()), "realized_up_rate": float(up.mean())},
        {"model": "constant_50", "log_loss": B.log_loss(base, up), "brier": B.brier(base, up),
         "mean_p_up": 0.5, "realized_up_rate": float(up.mean())},
    ])


def distribution_section(ep, m_te, pred, levels=RET_LEVELS):
    R = ep.R.to_numpy()[m_te]
    q = I.return_quantiles(pred, levels)
    return {
        "pinball_R": B.pinball(q, R, levels),
        "crps_R": B.crps_from_quantiles(q, R, levels),
        "coverage": [
            {"level": float(l), "empirical": float((R <= q[:, i]).mean())}
            for i, l in enumerate(levels)
        ],
    }


# --------------------------------------------------------------------------
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Evaluate NOCTUA out-of-sample")
    p.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    p.add_argument("--model", type=Path, default=Path("model/artifacts/noctua.pt"))
    p.add_argument("--out", type=Path, default=Path("model/artifacts/eval.json"))
    a = p.parse_args(argv)

    ep, X = load_all(a.artifacts)
    fin = np.isfinite(X.to_numpy()).all(1)
    sp = S.time_splits(ep)
    prod = S.production_mask(ep)

    m_tr = sp["train"] & fin
    m_te = sp["test"] & fin & prod
    wtr = S.sample_weights(ep, m_tr)

    model, ck = load_model(a.model)
    te, _ = prepare(ep, X, m_te, *stds_from_ck(ck))
    _y = B.har_target(ep.RV.to_numpy(), ep.H.to_numpy())
    _bl = B.fit_vol_baselines(X[m_tr], _y[m_tr], wtr)
    pred = I.predict(model, te, har_logvol=_bl['log_har_cal'].predict(X[m_te]))
    calib = NoctuaCalibration.from_dict(ck["calibration"]) if "calibration" in ck else None

    print(f"[eval] production-slice test episodes = {int(m_te.sum())}")
    print(f"[eval] {ep.dt[m_te].min()}  ->  {ep.dt[m_te].max()}\n")

    vol, _ = volatility_section(ep, X, m_tr, m_te, pred, wtr)
    print("=== 1. VOLATILITY (lower QLIKE better; vs_ref = % vs log_har_cal) ===")
    print(vol.round(4).to_string(index=False), "\n")

    bar = barrier_section(ep, X, m_tr, m_te, pred, calib)
    print("=== 2. BARRIER CALIBRATION (realized touch rate should equal alpha) ===")
    print(bar.round(4).to_string(index=False), "\n")

    dirn = direction_section(ep, m_te, pred)
    print("=== 3. DIRECTION ===")
    print(dirn.round(4).to_string(index=False), "\n")

    dist = distribution_section(ep, m_te, pred)
    print("=== 4. TERMINAL-RETURN DISTRIBUTION ===")
    print(json.dumps(dist, indent=2), "\n")

    a.out.write_text(json.dumps({
        "n_test": int(m_te.sum()),
        "test_start": str(ep.dt[m_te].min()),
        "test_end": str(ep.dt[m_te].max()),
        "params": int(model.n_params()),
        "volatility": vol.to_dict("records"),
        "barrier": bar.to_dict("records"),
        "direction": dirn.to_dict("records"),
        "distribution": dist,
    }, indent=2, default=float) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
