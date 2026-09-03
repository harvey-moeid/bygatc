"""
eval/by_expiry.py
=====================================================================
Does NOCTUA's skill depend on the EXPIRY it is asked about?

The model is trained across H in {6, 12, 19, 24} hours but only ever deployed
at H = 19 (17:00 UTC -> 12:00 UTC next day). Nothing in the project so far has
checked whether that single deployed horizon is where the model is strongest,
weakest, or unremarkable. If skill degrades sharply with H, the 19-hour product
is borrowing credibility from short-horizon performance it does not have; if it
degrades at SHORT horizons, the architecture is doing something the seller's
actual window benefits from.

Three quantities are reported per horizon, all out of sample:

  DSC/UNC   discrimination normalised by the uncertainty available to resolve.
            RAW DSC IS NOT COMPARABLE ACROSS HORIZONS for the same reason it is
            not comparable across assets: a 2% barrier is touched far more often
            over 24 hours than over 6, so the base rate -- and therefore the
            headroom -- differs. The skill-score form is the comparable one.

  coverage  mean |realized breach rate - nominal alpha|, a calibration
            diagnostic only. It is CHEATABLE (see BENCHMARK.md section 0) and
            is reported for completeness, never as evidence of skill.

  QLIKE     volatility loss against the realized variance.

Also reports the EMPIRICAL VOLATILITY SCALING EXPONENT. The model computes
sigma = exp(qa) * sqrt(H), which assumes variance grows linearly in time. That
is an assumption, and a testable one: regressing log median RV on log H over
the production anchors gives beta = 0.4808 against the 0.5 assumed -- mildly
sub-diffusive, consistent with mean reversion in volatility, and worth only a
2.6% correction across the whole 6h-24h span. Measured, not asserted, and small
enough to leave alone.

    python -m model.eval.by_expiry
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
BARRIER_PCT = np.array([1.0, 2.0, 3.0, 5.0])


def dsc_unc(p: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    base = float(np.mean(y))
    if base <= 0 or base >= 1 or len(y) < 40:
        return float("nan"), float("nan")
    pc = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip").fit_transform(p, y)
    ref = float(np.mean((base - y) ** 2))
    return ref - float(np.mean((pc - y) ** 2)), ref


def scaling_exponent(ep: pd.DataFrame) -> dict:
    """Is variance really linear in time? Regress log median RV on log H."""
    sub = ep[ep.anchor_hour == 17]
    g = sub.groupby("H").RV.median()
    lx, ly = np.log(g.index.values.astype(float)), np.log(g.values)
    beta, _ = np.polyfit(lx, ly, 1)
    span = (g.index.max() / g.index.min()) ** (beta - 0.5)
    return {"beta": float(beta), "assumed": 0.5,
            "error_across_H_range": float(span),
            "median_rv_by_H": {int(h): float(v) for h, v in g.items()}}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Skill as a function of expiry")
    ap.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    ap.add_argument("--out", type=Path, default=Path("model/artifacts/by_expiry.json"))
    a = ap.parse_args(argv)

    model = load_model()
    ep, X = load_all(a.artifacts)
    fin = np.isfinite(X.to_numpy()).all(1)
    test = S.time_splits(ep)["test"] & fin

    sc = scaling_exponent(ep)
    print(f"Skill by expiry -- {model.meta.get('version')}\n")
    print(f"Empirical volatility scaling: RV ~ H^{sc['beta']:.4f} "
          f"(sqrt(H) assumes 0.5000)")
    print(f"  error across the 6h-24h span if left uncorrected: "
          f"{sc['error_across_H_range']:.4f}x\n")

    rows = []
    for H in sorted(ep.H.unique()):
        # one non-overlapping episode per day per horizon, anchored at 17:00
        m = test & (ep.H == H).to_numpy() & (ep.anchor_hour == 17).to_numpy()
        if m.sum() < 60:
            continue
        e = ep[m]
        pred = model.predict(model.prepare(X[m], e.H.to_numpy(np.float64)))
        M_up, M_dn = np.abs(e.M_up.to_numpy()), np.abs(e.M_dn.to_numpy())
        rv = e.RV.to_numpy()
        sig = np.asarray(pred["sigma_med"], dtype=np.float64)

        errs = []
        for side, M in (("up", M_up), ("dn", M_dn)):
            for al in ALPHAS:
                lvl = model.safe_level(pred, float(al), side == "up")
                errs.append(abs(float((M >= lvl).mean()) - al))

        d_l, u_l = [], []
        for pct in BARRIER_PCT:
            u = np.full(int(m.sum()), np.log1p(pct / 100.0))
            d, un = dsc_unc(model.touch_prob(pred, u, True),
                            (M_up >= np.log1p(pct / 100.0)).astype(float))
            if np.isfinite(d):
                d_l.append(d)
                u_l.append(un)

        r = np.maximum(rv ** 2, 1e-18) / np.maximum(sig ** 2, 1e-18)
        rows.append({
            "H": int(H), "n": int(m.sum()),
            "sigma_pct": float(100 * sig.mean()),
            "rv_pct": float(100 * rv.mean()),
            "sigma_ratio": float(np.median(sig / np.maximum(rv, 1e-12))),
            "coverage_err_pp": float(100 * np.mean(errs)),
            "DSC": float(np.mean(d_l)) if d_l else float("nan"),
            "UNC": float(np.mean(u_l)) if u_l else float("nan"),
            "DSS": float(np.mean(d_l) / np.mean(u_l)) if u_l else float("nan"),
            "QLIKE": float(np.mean(r - np.log(r) - 1.0)),
        })

    df = pd.DataFrame(rows)
    print(f"{'H':>4} {'n':>5} {'sigma%':>8} {'rv%':>7} {'ratio':>7} "
          f"{'cov err':>8} {'DSC':>9} {'UNC':>7} {'DSC/UNC':>8} {'QLIKE':>7}")
    for _, r in df.iterrows():
        star = "  <- deployed" if r.H == 19 else ""
        print(f"{int(r.H):>4} {int(r.n):>5} {r.sigma_pct:8.3f} {r.rv_pct:7.3f} "
              f"{r.sigma_ratio:7.3f} {r.coverage_err_pp:8.3f} {r.DSC:9.5f} "
              f"{r.UNC:7.4f} {r.DSS:8.4f} {r.QLIKE:7.4f}{star}")

    if len(df) > 1:
        best = df.loc[df.DSS.idxmax()]
        worst = df.loc[df.DSS.idxmin()]
        dep = df[df.H == 19]
        print(f"\n  best horizon by DSC/UNC:  H={int(best.H)} at {best.DSS:.4f}")
        print(f"  worst horizon:            H={int(worst.H)} at {worst.DSS:.4f}")
        if not dep.empty:
            d = float(dep.DSS.iloc[0])
            print(f"  DEPLOYED H=19:            {d:.4f}  "
                  f"({100 * (d / best.DSS - 1):+.1f}% vs best)")

    a.out.write_text(json.dumps({"scaling": sc, "by_horizon": rows},
                                indent=2, default=float) + "\n")
    print(f"\nwritten -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
