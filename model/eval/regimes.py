"""
eval/regimes.py
=====================================================================
Conditional calibration by volatility regime, on REAL Bitcoin, strictly
out of sample.

Why this exists. The synthetic battery (eval/synthetic.py) showed NOCTUA
over-states touch probability on a LOW-VOLATILITY Gaussian instrument -- at a
1% window sigma it put 12.8% on a 2% barrier where the reflection principle
says 4.6%. That is not automatically a defect: real Bitcoin at low volatility
is not Gaussian either, and applying a fat tail there may be exactly right.
The two hypotheses are

  H0  the model applies a fat tail everywhere, and on real BTC that is
      CORRECT, so low-vol episodes are properly calibrated;
  H1  the model is genuinely miscalibrated in the low-vol regime, quoting
      levels further out than the data warrants.

They are distinguishable, and only on real data. Marginal calibration cannot
tell them apart -- a model can be perfectly calibrated on average while being
too wide in calm markets and too tight in violent ones, because the two errors
cancel in the pooled average. That cancellation is precisely what a
conditional test breaks.

The economics are not symmetric, which is why this matters. Quoting a strike
further out than necessary is SAFE but costs premium: the seller collects less
for the same risk, every single night, in whichever regime the bias lives.
Nearly 30% of Bitcoin episodes sit below 2% window volatility, so a bias
confined to calm markets is not a corner case.

Evaluation is on 2024-07-01 onward -- after both the training and calibration
splits -- using the shipped artifact exactly as deployed.

    python -m model.eval.regimes
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua import splits as S                                      # noqa: E402
from noctua.train import load_all                                   # noqa: E402
from serve.runtime import load_model                                # noqa: E402

ALPHAS = np.array([0.01, 0.02, 0.05, 0.10, 0.20])
N_BUCKETS = 5


def dsc(p: np.ndarray, y: np.ndarray) -> float:
    """CORP discrimination. Exactly 0 for any constant forecaster."""
    base = float(np.mean(y))
    if base <= 0 or base >= 1:
        return float("nan")
    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    pc = iso.fit_transform(p, y)
    return float(np.mean((base - y) ** 2) - np.mean((pc - y) ** 2))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Regime-conditional calibration")
    ap.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    ap.add_argument("--out", type=Path, default=Path("model/artifacts/regimes.json"))
    a = ap.parse_args(argv)

    model = load_model()
    ep, X = load_all(a.artifacts)
    fin = np.isfinite(X.to_numpy()).all(1)
    m = S.time_splits(ep)["test"] & fin & S.production_mask(ep)
    e = ep[m]
    print(f"Regime-conditional calibration -- {model.meta.get('version')}")
    print(f"out-of-sample: {e.dt.min().date()} .. {e.dt.max().date()}  n={m.sum()}\n")

    d = model.prepare(X[m], e.H.to_numpy(np.float64))
    pred = model.predict(d)
    sig = pred["sigma_med"]
    M_up, M_dn = np.abs(e.M_up.to_numpy()), np.abs(e.M_dn.to_numpy())

    # levels the model would actually quote
    lev = {side: {float(al): model.safe_level(pred, float(al), side == "up")
                  for al in ALPHAS} for side in ("up", "dn")}

    edges = np.quantile(sig, np.linspace(0, 1, N_BUCKETS + 1))
    edges[-1] += 1e-12
    bucket = np.clip(np.digitize(sig, edges[1:-1]), 0, N_BUCKETS - 1)

    print("Realized breach rate by predicted-volatility quintile.")
    print("Nominal is the alpha the model promised. Above nominal = too tight")
    print("(dangerous); below nominal = too wide (safe but costs premium).\n")
    header = f"{'quintile':<10} {'sigma range':>16} {'n':>5} " + \
             " ".join(f"{100*al:>5.0f}%" for al in ALPHAS)
    rows = []
    for side in ("up", "dn"):
        M = M_up if side == "up" else M_dn
        print(f"  --- {side}side ---")
        print("  " + header)
        for b in range(N_BUCKETS):
            sel = bucket == b
            cells = []
            rec = {"side": side, "bucket": int(b), "n": int(sel.sum()),
                   "sigma_lo": float(100 * edges[b]), "sigma_hi": float(100 * edges[b + 1])}
            for al in ALPHAS:
                rate = float((M[sel] >= lev[side][float(al)][sel]).mean())
                cells.append(f"{100*rate:5.1f}")
                rec[f"rate_{al}"] = rate
            rows.append(rec)
            print(f"  {'Q'+str(b+1):<10} {100*edges[b]:6.2f}-{100*edges[b+1]:<8.2f}% "
                  f"{sel.sum():>5} " + " ".join(cells))
        print(f"  {'NOMINAL':<10} {'':>16} {'':>5} " +
              " ".join(f"{100*al:5.1f}" for al in ALPHAS) + "\n")

    # ratio summary: realized / nominal, averaged over alphas
    print("Realized/nominal ratio (1.00 = perfect; <1 = too wide, >1 = too tight)")
    print(f"  {'quintile':<10} {'upside':>8} {'downside':>10}")
    ratios = {}
    for b in range(N_BUCKETS):
        sel = bucket == b
        rr = {}
        for side in ("up", "dn"):
            M = M_up if side == "up" else M_dn
            r = np.mean([(M[sel] >= lev[side][float(al)][sel]).mean() / al
                         for al in ALPHAS])
            rr[side] = float(r)
        ratios[b] = rr
        print(f"  {'Q'+str(b+1):<10} {rr['up']:8.3f} {rr['dn']:10.3f}")

    # discrimination within each regime -- does the model still carry
    # conditional information once volatility level is controlled for?
    print("\nCORP discrimination WITHIN each quintile, 2% barrier")
    print("(controls for the vol level: does the model know more than 'vol is high'?)")
    u2 = np.full(m.sum(), np.log1p(0.02))
    p2 = model.touch_prob(pred, u2, True)
    y2 = (M_up >= np.log1p(0.02)).astype(float)
    print(f"  {'quintile':<10} {'DSC':>10} {'base rate':>11}")
    dsc_rows = []
    for b in range(N_BUCKETS):
        sel = bucket == b
        v = dsc(p2[sel], y2[sel])
        dsc_rows.append({"bucket": b, "dsc": v, "base": float(y2[sel].mean())})
        print(f"  {'Q'+str(b+1):<10} {v:10.5f} {y2[sel].mean():11.3f}")
    print(f"  {'POOLED':<10} {dsc(p2, y2):10.5f} {y2.mean():11.3f}")

    a.out.write_text(json.dumps(
        {"rows": rows, "ratios": ratios, "dsc": dsc_rows,
         "edges_pct": (100 * edges).tolist()}, indent=2, default=float) + "\n")
    print(f"\nwritten -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
