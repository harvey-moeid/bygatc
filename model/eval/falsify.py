"""
eval/falsify.py
=====================================================================
Falsification tests: is NOCTUA REASONING about the market state, or is it a
well-mannered lookup table?

A model can post good aggregate scores for reasons that have nothing to do
with understanding. It can memorise the unconditional distribution, exploit a
leak, or ride a single dominant feature while ignoring everything else. None
of that shows up in a mean loss. These four tests are designed to make a model
that is faking it FAIL, and they are deliberately hostile.

  1. PERMUTATION IMPORTANCE -- shuffle one feature across episodes and measure
     how much the proper score degrades. A feature the model does not actually
     use costs nothing when destroyed. This exposes decorative inputs.

  2. MONOTONE RESPONSE -- sweep the trailing-volatility input across its
     plausible range and watch the forecast. There is exactly one right answer
     here: raise recent volatility and the predicted excursion MUST widen.
     This is not a statistical test, it is a structural one -- a model that
     gets it wrong has learned a correlation, not the mechanism, and no amount
     of good calibration redeems it.

  3. SHARPNESS UNDER STATE -- the forecast must actually MOVE. Its dispersion
     across episodes is bounded above by nothing and below by zero; a lookup
     table sits at zero. Measured as the coefficient of variation of the
     alpha=5% safe level across the test set, versus the same quantity for a
     climatology (exactly 0 by construction).

  4. TAIL SANITY UNDER EXTRAPOLATION -- feed the model states far outside
     anything in training (volatility at 10x the historical maximum) and check
     the output stays finite, ordered, and monotone. This is the hallucination
     test: a model that produces confident nonsense off-distribution is
     dangerous precisely when it matters most.

Runs against the SHIPPED artifact -- NumPy + SciPy only, no retraining --
so it tests what is actually deployed, not a reconstruction of it.

    python -m model.eval.falsify
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua.features import build_features                          # noqa: E402
from serve.history import load_bundle                               # noqa: E402
from serve.runtime import load_model                                # noqa: E402

FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = ""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + detail}")
    if not ok:
        FAILS.append(name)


def build_episodes(hours: pd.DataFrame, n: int, H: int = 19) -> pd.DataFrame:
    """A block of real anchors from the committed history bundle."""
    hour_ts = hours["hour_ts"].to_numpy(np.int64)
    lo = max(24 * 370, len(hours) - n - 5)
    rows = np.arange(lo, min(lo + n, len(hours) - 1))
    dt = pd.to_datetime(hour_ts[rows], unit="s", utc=True)
    return pd.DataFrame({
        "anchor_ts": hour_ts[rows], "H": H, "row": rows, "dt": dt,
        "anchor_hour": dt.hour, "dow": dt.dayofweek,
    })


def pinball(Q: np.ndarray, y: np.ndarray, taus: np.ndarray) -> float:
    tot = 0.0
    for j, t in enumerate(taus):
        d = y - Q[:, j]
        tot += float(np.mean(np.maximum(t * d, (t - 1.0) * d)))
    return tot / len(taus)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="NOCTUA falsification suite")
    p.add_argument("--n", type=int, default=400)
    p.add_argument("--out", type=Path, default=Path("model/artifacts/falsify.json"))
    a = p.parse_args(argv)

    model = load_model()
    print(f"NOCTUA falsification suite -- {model.meta.get('version')} "
          f"({model.meta.get('n_params_total', 0):,} params)\n")

    hours = load_bundle()
    ep = build_episodes(hours, a.n)
    X = build_features(hours, ep)
    Hv = ep.H.to_numpy(np.float64)
    d0 = model.prepare(X, Hv)
    base = model.predict(d0)
    taus = 1.0 - model.alpha_grid
    Q0 = model.committee_quantiles(base, True)
    sig0 = base["sigma_med"].copy()
    report: dict = {}

    # =====================================================================
    # 1. permutation importance
    # =====================================================================
    print("1. PERMUTATION IMPORTANCE  (proper-score damage when a feature is destroyed)")
    print("   A feature worth nothing to the model costs nothing to shuffle.\n")
    # Self-consistency target: the model's own median excursion. Using a
    # model-derived target isolates "does the forecast MOVE with this feature"
    # from "is the forecast right", which is what importance should mean.
    y_ref = Q0[:, int(np.argmin(np.abs(model.alpha_grid - 0.05)))]
    base_loss = pinball(Q0, y_ref, taus)

    rng = np.random.default_rng(0)
    imp = []
    for col in X.columns:
        Xp = X.copy()
        Xp[col] = Xp[col].to_numpy()[rng.permutation(len(Xp))]
        pr = model.predict(model.prepare(Xp, Hv))
        Qp = model.committee_quantiles(pr, True)
        imp.append({"feature": col,
                    "pinball_damage": pinball(Qp, y_ref, taus) - base_loss,
                    "sigma_shift_pct": float(100 * np.mean(
                        np.abs(pr["sigma_med"] - sig0) / np.maximum(sig0, 1e-12)))})
    impd = pd.DataFrame(imp).sort_values("sigma_shift_pct", ascending=False)
    print(impd.head(10).round(5).to_string(index=False))
    dead = impd[impd.sigma_shift_pct < 0.01]
    print(f"\n   features the model effectively IGNORES (<0.01% sigma shift): "
          f"{len(dead)} / {len(impd)}")
    if len(dead):
        print("     " + ", ".join(dead.feature.tolist()[:12]))
    report["permutation"] = impd.to_dict("records")
    check("model uses more than a handful of features",
          int((impd.sigma_shift_pct > 0.1).sum()) >= 5,
          f"only {(impd.sigma_shift_pct > 0.1).sum()} features move sigma > 0.1%")

    # =====================================================================
    # 2. monotone response to trailing volatility
    # =====================================================================
    print("\n2. MONOTONE RESPONSE TO VOLATILITY")
    print("   Raise recent volatility; the forecast excursion must widen. There is")
    print("   no defensible model in which it does not.\n")
    vol_cols = [c for c in ("har_1d", "har_5d", "har_22d") if c in X.columns]
    sweep = np.linspace(-1.5, 1.5, 13)     # log-vol shift, ~ -78% to +348%
    sig_curve, lvl_curve = [], []
    for s in sweep:
        Xs = X.copy()
        for c in vol_cols:
            Xs[c] = Xs[c] + s
        pr = model.predict(model.prepare(Xs, Hv))
        sig_curve.append(float(np.mean(pr["sigma_med"])))
        lvl_curve.append(float(np.mean(model.safe_level(pr, 0.05, True))))
    sig_curve, lvl_curve = np.array(sig_curve), np.array(lvl_curve)
    for s, sg, lv in zip(sweep[::3], sig_curve[::3], lvl_curve[::3]):
        print(f"   log-vol shift {s:+.2f}  ->  sigma {100*sg:6.3f}%   "
              f"5% safe level {100*lv:6.3f}%")
    check("sigma is strictly increasing in trailing volatility",
          bool((np.diff(sig_curve) > 0).all()),
          f"violations at {np.where(np.diff(sig_curve) <= 0)[0].tolist()}")
    check("5% safe level is strictly increasing in trailing volatility",
          bool((np.diff(lvl_curve) > 0).all()),
          f"violations at {np.where(np.diff(lvl_curve) <= 0)[0].tolist()}")
    elast = float(np.polyfit(sweep, np.log(sig_curve), 1)[0])
    print(f"\n   elasticity d(log sigma)/d(log trailing vol) = {elast:.3f}")
    check("volatility elasticity is economically sane (0.2-1.2)",
          0.2 < elast < 1.2, f"{elast:.3f}")
    report["monotone"] = {"sweep": sweep.tolist(), "sigma": sig_curve.tolist(),
                          "level_5pct": lvl_curve.tolist(), "elasticity": elast}

    # =====================================================================
    # 3. sharpness: does the forecast actually move?
    # =====================================================================
    print("\n3. SHARPNESS UNDER STATE  (a lookup table has dispersion exactly 0)")
    lvl = model.safe_level(base, 0.05, True)
    cv = float(np.std(lvl) / np.mean(lvl))
    rng_ratio = float(np.max(lvl) / np.min(lvl))
    print(f"   alpha=5% safe level across {a.n} episodes: "
          f"CV={cv:.4f}, max/min={rng_ratio:.2f}x   (climatology: CV=0, ratio=1.00x)")
    check("forecast varies materially with state", cv > 0.10, f"CV {cv:.4f}")
    report["sharpness"] = {"cv": cv, "max_over_min": rng_ratio}

    # =====================================================================
    # 4. hallucination check: far off-distribution states
    # =====================================================================
    print("\n4. OFF-DISTRIBUTION SANITY  (states far outside anything in training)")
    for shift, label in ((3.0, "vol x20"), (6.0, "vol x400"), (-6.0, "vol /400")):
        Xs = X.copy()
        for c in vol_cols:
            Xs[c] = Xs[c] + shift
        pr = model.predict(model.prepare(Xs, Hv))
        Qx = model.committee_quantiles(pr, True)
        finite = bool(np.all(np.isfinite(Qx)))
        monoton = bool((np.diff(Qx[:, ::-1], axis=1) >= -1e-12).all())
        positive = bool(np.all(Qx > 0))
        tp = model.touch_prob(pr, np.full(len(Xs), 0.02), True)
        inrange = bool(np.all((tp >= 0) & (tp <= 1)))
        print(f"   {label:<11} finite={finite} monotone={monoton} "
              f"positive={positive} prob_in_[0,1]={inrange}  "
              f"sigma={100*float(np.mean(pr['sigma_med'])):.3f}%")
        check(f"off-distribution output stays well-formed ({label})",
              finite and monoton and positive and inrange)

    print()
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(report, indent=2, default=float) + "\n")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
        return 1
    print("all falsification checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
