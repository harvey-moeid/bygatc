"""
noctua/train_v2.py
=====================================================================
Train and export the production NOCTUA v2 artifact.

v2 = width 32 (not 128) x 3 seeds + a flat, equal-weight committee of four
specialists, pooled by Vincentization over a shared set of sigma atoms.

Every one of those choices is a measured result, not a preference -- see
RESULTS_V2.md. In particular the committee weights are EQUAL on purpose: both
the level-dependent fit and the state-dependent gate were built and both
converged to uniform-or-degenerate, so the estimated weights were discarded in
favour of the average they kept reproducing.

    python -m noctua.train_v2 --out model/serve/noctua_v2.npz
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from . import baselines as B
from . import infer as I
from . import splits as S
from .committee import ALPHA_GRID, EmpiricalSpecialist, EVTSpecialist
from .model import BASE_COLS, LEVELS, SHAPE_COLS
from .train import load_all, prepare, train_model

HIDDEN = 32
SEEDS = 3


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Train + export NOCTUA v2")
    p.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    p.add_argument("--hidden", type=int, default=HIDDEN)
    p.add_argument("--seeds", type=int, default=SEEDS)
    p.add_argument("--out", type=Path, default=Path("model/serve/noctua_v2.npz"))
    a = p.parse_args(argv)

    ep, X = load_all(a.artifacts)
    fin = np.isfinite(X.to_numpy()).all(1)
    sp = S.time_splits(ep)
    m_tr, m_va = sp["train"] & fin, sp["calib"] & fin
    H = ep.H.to_numpy(np.float64)
    yall = B.har_target(ep.RV.to_numpy(), H)

    # Stage B is trained against a CAUSAL volatility reference, not the
    # realized RV. Measured: training on RV fits a target with sd 0.5490 while
    # serving faces 0.9312, and RV in both the target's denominator and its
    # conditioner manufactures Spearman -0.4331 out of pure arithmetic. The
    # replacement is exp(har_1d)*sqrt(H) -- a FEATURE, built from bars strictly
    # before the anchor, so nothing is fitted and nothing can leak -- clipped to
    # the [0.5%, 99.5%] range observed on the TRAINING episodes.
    #
    # Walk-forward, 6 folds, 3 seeds: DSC/UNC 0.04980 -> 0.05382, better in
    # 6/6 folds, with pinball and CRPS improving in 5/6 and QLIKE unchanged.
    # See BENCHMARK.md section 6b.
    raw_sig = np.exp(X["har_1d"].to_numpy(np.float64)) * np.sqrt(H)
    lo, hi = np.quantile(raw_sig[m_tr], [0.005, 0.995])
    sigma_ref = np.maximum(np.clip(raw_sig, lo, hi), 1e-12)

    tr, stds = prepare(ep, X, m_tr, sigma_ref=sigma_ref[m_tr])
    va, _ = prepare(ep, X, m_va, *stds, sigma_ref=sigma_ref[m_va])
    wtr = S.sample_weights(ep, m_tr)

    ols_std = B.OLS(BASE_COLS).fit(pd.DataFrame(tr["Xb"], columns=BASE_COLS),
                                   tr["y"].astype(np.float64), wtr)

    print(f"[v2] training {a.seeds} seeds at width {a.hidden} ...")
    models = []
    for s in range(a.seeds):
        m, _ = train_model(tr, wtr, va, hidden=a.hidden, epochs=40, seed=s,
                           verbose=False, ols_beta=ols_std.beta)
        models.append(m)
    n_par = models[0].n_params()
    print(f"[v2] {n_par:,} params per seed, {n_par * a.seeds:,} total")

    # analytic specialists are fitted on the TRAINING split only
    emp = EmpiricalSpecialist().fit(ep.M_up.to_numpy()[m_tr], ep.M_dn.to_numpy()[m_tr],
                                    ep.RV.to_numpy()[m_tr])
    evt = EVTSpecialist().fit(ep.M_up.to_numpy()[m_tr], ep.M_dn.to_numpy()[m_tr],
                              ep.RV.to_numpy()[m_tr])
    print(f"[v2] EVT shape xi: up={evt.par['up']['xi']:+.4f} dn={evt.par['dn']['xi']:+.4f}")

    arrays: dict = {}
    for s, m in enumerate(models):
        for k, v in m.state_dict().items():
            arrays[f"m{s}.{k}"] = v.detach().numpy().astype(np.float32)

    arrays["levels"] = LEVELS.astype(np.float64)
    arrays["alpha_grid"] = ALPHA_GRID.astype(np.float64)
    arrays["har_beta"] = np.asarray(ols_std.beta, dtype=np.float64)
    for name, key in (("std_all", "std_all"), ("std_shape", "std_shape"),
                      ("std_base", "std_base")):
        idx = {"std_all": 0, "std_shape": 1, "std_base": 2}[key]
        arrays[f"{name}_mu"] = np.asarray(stds[idx].mu, dtype=np.float64)
        arrays[f"{name}_sd"] = np.asarray(stds[idx].sd, dtype=np.float64)

    arrays["emp_z_up"] = emp.z_up
    arrays["emp_z_dn"] = emp.z_dn
    for side in ("up", "dn"):
        pr = evt.par[side]
        arrays[f"evt_{side}"] = np.array([pr["u"], pr["xi"], pr["beta"], evt.tq])
        arrays[f"evt_{side}_emp"] = pr["emp"]

    meta = {
        "version": "NOCTUA-v2",
        # From prepare(), NOT list(X.columns): features.parquet may carry
        # research columns the model deliberately does not consume.
        "feat_cols": tr["cols"]["all"],
        "base_cols": tr["cols"]["base"], "shape_cols": tr["cols"]["shape"],
        "hidden": a.hidden, "seeds": a.seeds,
        "blend_w": I.BLEND_W,
        "specialists": ["neural", "gaussian", "empirical", "evt"],
        "weights": "equal",   # measured: fitted and gated weights both degenerate
        "stage_b_sigma_ref": "causal_har_1d_clipped",
        "n_params_total": int(n_par * a.seeds),
    }
    arrays["meta_json"] = np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8)

    a.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(a.out, **arrays)
    print(json.dumps({**meta, "artifact_kb": round(a.out.stat().st_size / 1024, 1)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
