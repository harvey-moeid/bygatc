"""
noctua/eval_committee.py
=====================================================================
Walk-forward evaluation of the NOCTUA v2 committee against v1.

Identical protocol to v1 so the comparison means something: expanding-window
folds, embargoed splits, weights and calibration fitted only on each fold's own
calibration slice, and every number reported on the PRODUCTION slice (19 h
window opened at 17:00 UTC, one non-overlapping episode per day).

Reported per alpha, because the whole premise of the committee is that
specialist competence VARIES with the barrier level.
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
from .committee import (ALPHA_GRID, Committee, EmpiricalSpecialist, EVTSpecialist,
                        GATE_FEATURES, GatedCommittee, GaussianSpecialist,
                        NeuralSpecialist)
from .evaluate import block_bootstrap_pvalue
from .model import BASE_COLS
from .train import load_all, prepare, train_model

REPORT_ALPHAS = [0.01, 0.02, 0.05, 0.10, 0.20, 0.30]


def build_fold(ep, X, fold, hidden, seeds, verbose=False):
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
    H = ep.H.to_numpy(np.float64)
    yall = B.har_target(ep.RV.to_numpy(), H)

    ols = B.OLS(BASE_COLS).fit(pd.DataFrame(tr["Xb"], columns=BASE_COLS),
                               tr["y"].astype(np.float64), wtr)
    bl = B.fit_vol_baselines(X[m_tr], yall[m_tr], wtr)

    # --- seed ensemble of tiny nets (variance reduction, ~free) -----------
    models = [train_model(tr, wtr, va, hidden=hidden, epochs=40, seed=s,
                          verbose=verbose, ols_beta=ols.beta)[0] for s in range(seeds)]

    def predict_avg(mask):
        d, _ = prepare(ep, X, mask, *stds)
        lp = bl["log_har_cal"].predict(X[mask])
        preds = [I.predict(m, d, har_logvol=lp) for m in models]
        out = dict(preds[0])
        for k in ("qa", "sigma_atoms", "sigma_med", "q_r", "q_up", "q_dn"):
            out[k] = np.mean([p[k] for p in preds], axis=0)
        return out, lp

    # --- calibration slice: fit specialists and pooling weights -----------
    m_cal = m_va & (ep.H == 19).to_numpy()
    p_cal, lp_cal = predict_avg(m_cal)
    e_cal = ep[m_cal]
    sig_cal = np.exp(lp_cal) * np.sqrt(H[m_cal])

    specs = [
        NeuralSpecialist(),
        GaussianSpecialist().fit(e_cal.M_up.to_numpy(), e_cal.M_dn.to_numpy(), sig_cal),
        EmpiricalSpecialist().fit(ep.M_up.to_numpy()[m_tr], ep.M_dn.to_numpy()[m_tr],
                                  ep.RV.to_numpy()[m_tr]),
        EVTSpecialist().fit(ep.M_up.to_numpy()[m_tr], ep.M_dn.to_numpy()[m_tr],
                            ep.RV.to_numpy()[m_tr]),
    ]
    comm = Committee(specs).fit(sig_cal, p_cal,
                                e_cal.M_up.to_numpy(), e_cal.M_dn.to_numpy())

    # The estimator that actually ships: equal weights, nothing fitted. Scored
    # as its own arm so the headline number describes the released artifact
    # rather than the SLSQP variant.
    equal = Committee(specs).fit_equal()

    # NOCTUA-as-parent: a gate that picks children per episode, not per alpha
    G_cal = X.loc[m_cal, GATE_FEATURES].to_numpy(np.float64)
    gated = GatedCommittee(specs).fit(G_cal, sig_cal, p_cal,
                                      e_cal.M_up.to_numpy(), e_cal.M_dn.to_numpy())

    # --- test slice --------------------------------------------------------
    p_te, lp_te = predict_avg(m_te)
    e_te = ep[m_te]
    sig_te = np.exp(lp_te) * np.sqrt(H[m_te])
    M_up, M_dn = e_te.M_up.to_numpy(), -e_te.M_dn.to_numpy()
    G_te = X.loc[m_te, GATE_FEATURES].to_numpy(np.float64)

    rows = []
    for a in REPORT_ALPHAS:
        u_n = I.safe_level(p_te, a, True)
        l_n = I.safe_level(p_te, a, False)
        u_g = -sig_te * norm.ppf(a / 2.0)
        u_c = comm.safe_level(sig_te, p_te, a, True)
        l_c = comm.safe_level(sig_te, p_te, a, False)
        u_e = equal.safe_level(sig_te, p_te, a, True)
        l_e = equal.safe_level(sig_te, p_te, a, False)
        u_x = gated.safe_level(G_te, sig_te, p_te, a, True)
        l_x = gated.safe_level(G_te, sig_te, p_te, a, False)
        rows.append({
            "alpha": a,
            "noctua": 100 * 0.5 * (abs((M_up >= u_n).mean() - a) + abs((M_dn >= l_n).mean() - a)),
            "gauss": 100 * 0.5 * (abs((M_up >= u_g).mean() - a) + abs((M_dn >= u_g).mean() - a)),
            "committee": 100 * 0.5 * (abs((M_up >= u_c).mean() - a) + abs((M_dn >= l_c).mean() - a)),
            "equal": 100 * 0.5 * (abs((M_up >= u_e).mean() - a) + abs((M_dn >= l_e).mean() - a)),
            "gated": 100 * 0.5 * (abs((M_up >= u_x).mean() - a) + abs((M_dn >= l_x).mean() - a)),
            "cte_up": float((M_up >= u_c).mean()), "cte_dn": float((M_dn >= l_c).mean()),
        })

    # volatility QLIKE of the seed-averaged model
    rv, Ht = e_te.RV.to_numpy(), H[m_te]

    def ql(lp):
        pv = (np.exp(lp) * np.sqrt(Ht)) ** 2
        r = np.maximum(rv**2, 1e-18) / np.maximum(pv, 1e-18)
        return r - np.log(r) - 1.0

    return {
        "year": fold["year"], "n": int(m_te.sum()),
        "barrier": rows,
        "q_noc": ql(np.log(p_te["sigma_med"]) - 0.5 * np.log(Ht)),
        "q_ref": ql(bl["log_har_cal"].predict(X[m_te])),
        "weights_up": comm.W_up.tolist(), "names": comm.names,
        "gate_W": gated.W.tolist(), "gate_b": gated.b.tolist(),
        "gate_w_mean": gated.weights(G_te).mean(axis=0).tolist(),
        "gate_w_std": gated.weights(G_te).std(axis=0).tolist(),
        "evt_xi_up": specs[3].par["up"]["xi"], "evt_xi_dn": specs[3].par["dn"]["xi"],
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Walk-forward evaluation of the committee")
    p.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    p.add_argument("--hidden", type=int, default=32)
    p.add_argument("--seeds", type=int, default=4)
    p.add_argument("--out", type=Path, default=Path("model/artifacts/committee_eval.json"))
    a = p.parse_args(argv)

    ep, X = load_all(a.artifacts)
    folds = S.walk_forward_folds(ep)
    print(f"[committee] hidden={a.hidden} seeds={a.seeds}  {len(folds)} folds\n")

    res = []
    for f in folds:
        r = build_fold(ep, X, f, a.hidden, a.seeds)
        if r is None:
            continue
        print(f"  {r['year']}: n={r['n']:3d}  "
              f"EVT xi up={r['evt_xi_up']:+.3f} dn={r['evt_xi_dn']:+.3f}")
        res.append(r)

    N = np.concatenate([r["q_noc"] for r in res])
    R = np.concatenate([r["q_ref"] for r in res])
    D = np.concatenate([r["q_ref"] - r["q_noc"] for r in res])
    print(f"\n=== VOLATILITY (seed-averaged, hidden={a.hidden}) ===")
    print(f"  QLIKE {N.mean():.4f} vs log_har_cal {R.mean():.4f}  "
          f"gain {100*(N.mean()/R.mean()-1):+.2f}%  p={block_bootstrap_pvalue(D):.4f}")

    print("\n=== BARRIER CALIBRATION: mean |error| pp, pooled over folds ===")
    tab = []
    for i, al in enumerate(REPORT_ALPHAS):
        row = {"alpha": al}
        for k in ("noctua", "gauss", "committee", "equal", "gated"):
            row[k] = float(np.mean([r["barrier"][i][k] for r in res]))
        row["cte_up"] = float(np.mean([r["barrier"][i]["cte_up"] for r in res]))
        row["cte_dn"] = float(np.mean([r["barrier"][i]["cte_dn"] for r in res]))
        tab.append(row)
    df = pd.DataFrame(tab)
    print(df.round(3).to_string(index=False))
    print(f"\n  mean over alphas:  noctua={df.noctua.mean():.3f}  "
          f"gauss={df.gauss.mean():.3f}  committee(fitted)={df.committee.mean():.3f}  "
          f"EQUAL(shipped)={df.equal.mean():.3f}  GATED={df.gated.mean():.3f}")
    lo = df[df.alpha <= 0.10]
    print(f"  mean over alphas <= 0.10 (the seller's range): "
          f"noctua={lo.noctua.mean():.3f}  gauss={lo.gauss.mean():.3f}  "
          f"committee(fitted)={lo.committee.mean():.3f}  "
          f"EQUAL(shipped)={lo.equal.mean():.3f}  GATED={lo.gated.mean():.3f}")

    print("\n=== GATE: per-episode weights on the final fold ===")
    print(f"{'child':>11} {'mean w':>9} {'sd across episodes':>20}")
    for k, nm in enumerate(res[-1]["names"]):
        print(f"{nm:>11} {res[-1]['gate_w_mean'][k]:9.3f} {res[-1]['gate_w_std'][k]:20.4f}")

    print("\n=== POOLING WEIGHTS (upside, final fold) ===")
    W = np.array(res[-1]["weights_up"])
    print(f"{'alpha':>7} " + " ".join(f"{n:>10}" for n in res[-1]["names"]))
    for j, al in enumerate(ALPHA_GRID):
        print(f"{al:7.3f} " + " ".join(f"{W[k, j]:10.3f}" for k in range(W.shape[0])))

    a.out.write_text(json.dumps({
        "hidden": a.hidden, "seeds": a.seeds,
        "qlike": {"committee_vol": float(N.mean()), "log_har_cal": float(R.mean()),
                  "gain_pct": float(100 * (N.mean() / R.mean() - 1)),
                  "p": block_bootstrap_pvalue(D)},
        "barrier": tab,
        "weights_up_final": res[-1]["weights_up"], "names": res[-1]["names"],
        "evt_xi": [{"year": r["year"], "up": r["evt_xi_up"], "dn": r["evt_xi_dn"]} for r in res],
    }, indent=2, default=float) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
