"""
noctua/walkforward.py
=====================================================================
Stage 6b: expanding-window walk-forward -- the headline evaluation.

For each test year Y:
    train      on everything ending before Y-1 July  (embargoed)
    calibrate  on Y-1 July .. Y January               (embargoed)
    test       on Y

Each fold retrains from scratch, so nothing from the test year touches the
weights, the standardizers, the OLS seed, or the recalibration maps.

This module also settles the calibration-shrinkage question empirically. The
first fixed-split run showed the PIT correction fitted on one period made
calibration WORSE on the next, because the sign of the tail miscalibration
flips between volatility regimes. Rather than guess, we sweep the shrinkage
across all folds and report the whole curve.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

from . import baselines as B
from . import infer as I
from . import splits as S
from .calibrate import NoctuaCalibration
from .evaluate import ALPHAS, block_bootstrap_pvalue
from .model import BASE_COLS
from .train import load_all, prepare, train_model

SHRINKS = (0.0, 0.25, 0.5, 1.0)


def run_fold(ep, X, fold, *, epochs, hidden, seed, verbose=False):
    fin = np.isfinite(X.to_numpy()).all(1)
    prod = S.production_mask(ep)
    m_tr = fold["train"] & fin
    m_va = fold["calib"] & fin
    m_te = fold["test"] & fin & prod
    if m_tr.sum() < 5000 or m_te.sum() < 30 or m_va.sum() < 500:
        return None

    tr, stds = prepare(ep, X, m_tr)
    va, _ = prepare(ep, X, m_va, *stds)
    wtr = S.sample_weights(ep, m_tr)

    ols = B.OLS(BASE_COLS).fit(pd.DataFrame(tr["Xb"], columns=BASE_COLS),
                               tr["y"].astype(np.float64), wtr)
    model, _ = train_model(tr, wtr, va, hidden=hidden, epochs=epochs, seed=seed,
                           verbose=verbose, ols_beta=ols.beta)

    # calibration on the fold's own calib slice (H=19, all anchors)
    m_cal19 = m_va & (ep.H == 19).to_numpy()
    cd, _ = prepare(ep, X, m_cal19, *stds)
    _bl = B.fit_vol_baselines(X[m_tr], B.har_target(ep.RV.to_numpy(), ep.H.to_numpy())[m_tr], wtr)
    pc = I.predict(model, cd, har_logvol=_bl['log_har_cal'].predict(X[m_cal19]))
    ec = ep[m_cal19]
    calib = NoctuaCalibration().fit(pc, ec.M_up.to_numpy(), ec.M_dn.to_numpy(), ec.R.to_numpy())

    te, _ = prepare(ep, X, m_te, *stds)
    e = ep[m_te]
    bl0 = B.fit_vol_baselines(X[m_tr], B.har_target(ep.RV.to_numpy(), ep.H.to_numpy())[m_tr], wtr)
    pred = I.predict(model, te, har_logvol=bl0['log_har_cal'].predict(X[m_te]))

    # ---- volatility ------------------------------------------------------
    H = ep.H.to_numpy(np.float64)
    y = B.har_target(ep.RV.to_numpy(), H)
    bl = B.fit_vol_baselines(X[m_tr], y[m_tr], wtr)
    rv_te, H_te = e.RV.to_numpy(), H[m_te]

    def qlike_per(logpred):
        pv = (np.exp(logpred) * np.sqrt(H_te)) ** 2
        r = np.maximum(rv_te**2, 1e-18) / np.maximum(pv, 1e-18)
        return r - np.log(r) - 1.0

    q_noc = qlike_per(np.log(pred["sigma_med"]) - 0.5 * np.log(H_te))
    q_ref = qlike_per(bl["log_har_cal"].predict(X[m_te]))
    q_har = qlike_per(bl["log_har"].predict(X[m_te]))

    # ---- barrier calibration at each shrinkage ---------------------------
    M_up, M_dn = e.M_up.to_numpy(), -e.M_dn.to_numpy()
    sig_har = np.exp(bl["log_har_cal"].predict(X[m_te])) * np.sqrt(H_te)
    bar = []
    for a in ALPHAS:
        rec = {"alpha": float(a)}
        u_g = -sig_har * norm.ppf(a / 2.0)
        rec["gauss_err_pp"] = 100 * 0.5 * (
            abs((M_up >= u_g).mean() - a) + abs((M_dn >= u_g).mean() - a)
        )
        for sh in SHRINKS:
            calib.shrink = sh
            u = calib.safe_level(pred, a, up=True)
            l = calib.safe_level(pred, a, up=False)
            rec[f"up_s{sh}"] = float((M_up >= u).mean())
            rec[f"dn_s{sh}"] = float((M_dn >= l).mean())
            rec[f"err_s{sh}"] = 100 * 0.5 * (
                abs((M_up >= u).mean() - a) + abs((M_dn >= l).mean() - a)
            )
        bar.append(rec)

    return {
        "year": fold["year"],
        "n_test": int(m_te.sum()),
        "n_train": int(m_tr.sum()),
        "qlike_noctua": float(q_noc.mean()),
        "qlike_log_har_cal": float(q_ref.mean()),
        "qlike_log_har": float(q_har.mean()),
        "qlike_gain_pct": float(100 * (q_noc.mean() / q_ref.mean() - 1.0)),
        "q_noc": q_noc, "q_ref": q_ref,
        "barrier": bar,
        "median_RV_pct": float(100 * np.median(rv_te)),
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Walk-forward evaluation of NOCTUA")
    p.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--hidden", type=int, default=128)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=Path, default=Path("model/artifacts/walkforward.json"))
    a = p.parse_args(argv)

    ep, X = load_all(a.artifacts)
    folds = S.walk_forward_folds(ep)
    print(f"[wf] {len(folds)} folds\n")

    results, dq_all = [], []
    for f in folds:
        r = run_fold(ep, X, f, epochs=a.epochs, hidden=a.hidden, seed=a.seed)
        if r is None:
            print(f"  {f['year']}: skipped (insufficient data)")
            continue
        dq_all.append(r["q_ref"] - r["q_noc"])
        print(f"  {r['year']}: n={r['n_test']:3d}  medRV={r['median_RV_pct']:.2f}%  "
              f"QLIKE noctua={r['qlike_noctua']:.4f} log_har_cal={r['qlike_log_har_cal']:.4f}  "
              f"gain={r['qlike_gain_pct']:+.1f}%")
        results.append(r)

    print("\n=== VOLATILITY, pooled across folds ===")
    d = np.concatenate(dq_all)
    pooled_noc = np.concatenate([r["q_noc"] for r in results])
    pooled_ref = np.concatenate([r["q_ref"] for r in results])
    print(f"  n = {len(d)} production episodes")
    print(f"  QLIKE  NOCTUA = {pooled_noc.mean():.4f}   log_har_cal = {pooled_ref.mean():.4f}")
    print(f"  gain = {100*(pooled_noc.mean()/pooled_ref.mean()-1):+.2f}%   "
          f"block-bootstrap p = {block_bootstrap_pvalue(d):.4f}")
    wins = sum(1 for r in results if r["qlike_gain_pct"] < 0)
    print(f"  folds won: {wins}/{len(results)}")

    print("\n=== BARRIER CALIBRATION: mean |error| in pp, pooled over folds ===")
    rows = []
    for i, a_ in enumerate(ALPHAS):
        rec = {"alpha": float(a_),
               "gauss": float(np.mean([r["barrier"][i]["gauss_err_pp"] for r in results]))}
        for sh in SHRINKS:
            rec[f"shrink={sh}"] = float(np.mean([r["barrier"][i][f"err_s{sh}"] for r in results]))
        rows.append(rec)
    tab = pd.DataFrame(rows)
    print(tab.round(3).to_string(index=False))
    print("\n  mean over alphas:")
    print("   ", {c: round(float(tab[c].mean()), 3) for c in tab.columns if c != "alpha"})

    a.out.write_text(json.dumps({
        "folds": [{k: v for k, v in r.items() if k not in ("q_noc", "q_ref")} for r in results],
        "pooled": {
            "n": int(len(d)),
            "qlike_noctua": float(pooled_noc.mean()),
            "qlike_log_har_cal": float(pooled_ref.mean()),
            "gain_pct": float(100 * (pooled_noc.mean() / pooled_ref.mean() - 1)),
            "p_block_bootstrap": block_bootstrap_pvalue(d),
            "folds_won": wins, "folds_total": len(results),
        },
        "barrier_calibration": tab.to_dict("records"),
    }, indent=2, default=float) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
