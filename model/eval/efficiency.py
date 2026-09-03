"""
eval/efficiency.py
=====================================================================
Does path efficiency actually add skill, or does it just look like it does?

THE HYPOTHESIS

BENCHMARK.md section 2 is the honest weak spot of this project: on binary
barrier discrimination the committee is TIED with a plain Log-HAR + Gaussian
first-passage baseline (DSC 0.008178 vs 0.008707), and its advantage lives
entirely in the full predictive distribution and in volatility. So the question
is not "predict volatility better" -- it is "what does a first-passage formula
assume that is not true?"

It assumes one thing very specifically. Under Brownian motion,

    E[max - min] = sigma * sqrt(8/pi) = 1.5958 * sigma

a CONSTANT ratio of range to volatility. Every Gaussian barrier price is that
constant in disguise. On BTC it is not constant:

    median 1.295, IQR [1.017, 1.612]        -- not 1.5958, and wide
    Spearman(trailing, forward) = +0.38     -- and it PERSISTS
    Spearman(efficiency, RV)    = -0.036    -- on an axis vol cannot see

Three numbers, and the third is the one that matters: a volatility model,
however good, is blind to this. So `eff_1d/3d/7d` -- log(range / sqrt(RV)) over
trailing 24/72/168 hours -- were put into the shape stage, which by
construction receives scale-free shape information and not the vol level.

THE RESULT: THE HYPOTHESIS FAILED

    metric          no_eff        eff       wins   t-like
    DSC/UNC        0.04980    0.05000       2/6     +0.22   <- the target
    pinball       0.003633   0.003644       1/6     -1.17
    CRPS          0.005307   0.005312       2/6     -0.50
    QLIKE          0.29984    0.29519       5/6     +2.03
    MCB            0.03040    0.03033       4/6     +0.61
    coverage err     1.629      1.831       0/6     -3.21

Discrimination -- the thing the features were built for and the reason for
choosing them -- is FLAT. Two folds out of six, a fold-level t-like of +0.22:
that is noise, and the arms remain 5.6% and 6.0% behind log_har_gauss
respectively, so the gap section 2 identified is untouched.

What did move is volatility (QLIKE, 5/6 folds, t-like +2.03), which the
features were not aimed at and reach only because the shape columns also enter
the wide block. And marginal coverage got consistently WORSE -- 0 folds out of
6 -- which is the cheatable metric but also the one section 6 spent real effort
repairing.

So: signal confirmed (Spearman 0.38, orthogonal to vol), mechanism sound,
transfer to the target metric absent. THESE FEATURES DO NOT SHIP. They stay in
features.py and out of SHAPE_COLS, with `NON_MODEL_COLS` ensuring that merely
computing them cannot widen the model's input and change the artifact by
accident.

One explanation is untested and is left untested on purpose: the committee
pools four specialists equally, and three of them are unconditional in shape,
so a neural shape improvement is diluted roughly fourfold before it reaches the
score. Testing the neural specialist alone might well show the effect. It
would also be the third hypothesis tried on the same test set, and picking the
slice where the number finally goes positive is how a benchmark gets cheated.
The negative result stands as recorded.

WHAT FAILED FIRST, AND WHY IT IS IN THIS FILE

The obvious cheap version -- fit an isotonic correction of the residual
(outcome - probability) on efficiency and add it to the shipped model's output
-- was tried and REJECTED. Fitted and scored on the same test slice it looked
excellent: +3% to +29% DSC, rising monotonically with barrier size. Fitted on
calib and applied to test it LOST 4.4% on average.

The sign was right in both splits and in all 8 barrier-side cells. The
magnitude was not transferable. That is the identical failure mode as the
volatility bias in BENCHMARK.md section 6: the effect is real, its LEVEL is
regime-dependent, and a fitted constant is the wrong instrument. Which is why
this goes in as a feature the network conditions on, not as a bolt-on shift.

It is recorded here because the in-sample number was the more impressive one,
and a file that only reports the version that worked would be advertising.

THE ABLATION

Both arms are identical -- same architecture, same 3 seeds, same 40 epochs,
same specialists, same folds, same everything -- except that the `eff` arm's
shape columns contain the three efficiency features and the shipped arm's do
not. `prepare(shape_cols=...)` drops them from the wide block too, so the
control arm genuinely cannot see them; without that, both arms would have
received the features through Xa and the ablation would have measured nothing.

Six expanding walk-forward folds, scored on the production slice only. Paired
by fold, because arm-vs-arm within a fold shares the fold's data and its noise;
the fold-level DIFFERENCE is the quantity with a claim to significance, and
with n = 6 that claim is weak and is reported as weak.

    python -m model.eval.efficiency
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua import splits as S                                      # noqa: E402
from noctua.spec import EFFICIENCY_COLS, SHAPE_COLS, SHAPE_COLS_WITH_EFF  # noqa: E402
from noctua.train import load_all                                   # noqa: E402

from .benchmark import BARRIER_PCT, run_fold                        # noqa: E402

ARMS = {"no_eff": SHAPE_COLS, "eff": SHAPE_COLS_WITH_EFF}


def summarise(rows: list[dict], model: str = "noctua_v2") -> dict:
    """Collapse one fold's per-barrier record into the headline quantities.

    DSC is aggregated as sum(DSC)/sum(UNC), not as a mean of ratios. The eight
    barrier-side cells have base rates from 0.02 to 0.52, so their UNC differs
    by an order of magnitude; averaging ratios would let the 5% barrier -- 17
    events in a fold -- carry the same weight as the 1% barrier's 396.
    """
    r = next(x for x in rows if x["model"] == model)
    dsc = sum(r[f"DSC_{s}_{p}"] for s in ("up", "dn") for p in BARRIER_PCT)
    unc = sum(r[f"UNC_{s}_{p}"] for s in ("up", "dn") for p in BARRIER_PCT)
    mcb = sum(r[f"MCB_{s}_{p}"] for s in ("up", "dn") for p in BARRIER_PCT)
    return {
        "DSS": dsc / unc, "DSC": dsc / 8.0, "MCB": mcb / 8.0,
        "pinball": 0.5 * (r["pinball_up"] + r["pinball_dn"]),
        "crps": 0.5 * (r["crps_up"] + r["crps_dn"]),
        "coverage_err": 0.5 * (r["coverage_err_up"] + r["coverage_err_dn"]),
        "n": r["n"],
    }


def paired(diffs: np.ndarray) -> dict:
    """Fold-level paired summary. n = 6; this is descriptive, not a p-value.

    A t-test on six paired differences has almost no power, and quoting one
    would dress up a small sample. The wins/losses count and the spread are
    reported instead, which is what six folds can honestly support.
    """
    d = np.asarray(diffs, dtype=float)
    se = d.std(ddof=1) / np.sqrt(len(d)) if len(d) > 1 else np.nan
    return {"mean": float(d.mean()), "sd": float(d.std(ddof=1)),
            "se": float(se), "t_like": float(d.mean() / se) if se else float("nan"),
            "wins": int((d > 0).sum()), "losses": int((d < 0).sum()),
            "per_fold": [float(x) for x in d]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Path-efficiency ablation")
    ap.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--hidden", type=int, default=32)
    ap.add_argument("--out", type=Path,
                    default=Path("model/artifacts/efficiency.json"))
    a = ap.parse_args(argv)

    ep, X = load_all(a.artifacts)
    missing = [c for c in SHAPE_COLS_WITH_EFF if c not in X.columns]
    if missing:
        print(f"features.parquet is missing {missing} -- rebuild it first")
        return 2

    folds = S.walk_forward_folds(ep)
    print(f"path-efficiency ablation: {len(folds)} folds x {len(ARMS)} arms "
          f"x {a.seeds} seeds\n")

    recs: list[dict] = []
    for f in folds:
        line = {"year": f["year"]}
        for arm, cols in ARMS.items():
            t0 = time.time()
            out = run_fold(ep, X, f, hidden=a.hidden, seeds=a.seeds,
                           shape_cols=cols)
            if out is None:
                line = None
                break
            s = summarise(out["rows"])
            s["qlike"] = out["vol"]["noctua"]
            s["qlike_har"] = out["vol"]["log_har"]
            s["DSS_har"] = summarise(out["rows"], "log_har_gauss")["DSS"]
            line[arm] = s
            print(f"  {f['year']}  {arm:7} n={s['n']:4d}  DSC/UNC {s['DSS']:.5f}  "
                  f"pinball {s['pinball']:.6f}  QLIKE {s['qlike']:.4f}  "
                  f"({time.time()-t0:.0f}s)", flush=True)
        if line:
            recs.append(line)

    if not recs:
        print("no usable folds")
        return 1

    print(f"\n{'metric':>14} {'no_eff':>10} {'eff':>10} {'delta':>10} "
          f"{'wins':>6} {'t-like':>7}")
    report = {}
    # (key, sign) -- sign +1 where higher is better
    for key, sgn in (("DSS", +1), ("pinball", -1), ("crps", -1),
                     ("qlike", -1), ("MCB", -1), ("coverage_err", -1)):
        a0 = np.array([r["no_eff"][key] for r in recs])
        a1 = np.array([r["eff"][key] for r in recs])
        p = paired(sgn * (a1 - a0))
        report[key] = {"no_eff": float(a0.mean()), "eff": float(a1.mean()),
                       "higher_is_better": sgn > 0, **p}
        print(f"{key:>14} {a0.mean():10.6f} {a1.mean():10.6f} "
              f"{a1.mean()-a0.mean():+10.6f} {p['wins']:>3}/{len(recs):<2} "
              f"{p['t_like']:+7.2f}")

    har = np.array([r["no_eff"]["DSS_har"] for r in recs]).mean()
    print(f"\n  reference -- log_har_gauss DSC/UNC: {har:.5f}")
    print(f"  no_eff {report['DSS']['no_eff']:.5f} "
          f"({100*(report['DSS']['no_eff']/har-1):+.1f}% vs log_har)")
    print(f"  eff    {report['DSS']['eff']:.5f} "
          f"({100*(report['DSS']['eff']/har-1):+.1f}% vs log_har)")
    print("\n  n = 6 folds. 't-like' is mean/se of the paired fold differences "
          "and is\n  descriptive only -- six points cannot support a p-value.")

    a.out.write_text(json.dumps(
        {"arms": {k: list(v) for k, v in ARMS.items()},
         "seeds": a.seeds, "hidden": a.hidden,
         "log_har_DSS": float(har), "summary": report,
         "folds": recs}, indent=2, default=float) + "\n")
    print(f"\nwritten -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
