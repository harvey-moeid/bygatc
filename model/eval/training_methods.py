"""
eval/training_methods.py
=====================================================================
Which way of TRAINING this model is actually best? Measured, not argued.

Everything tried before this attacked features (eval/efficiency.py) or
post-processing (eval/selfimprove.py), and both were refused. Neither touched
the training setup itself, which is where the following three problems live.

---------------------------------------------------------------------
ARM 1 -- serve_consistent: stage B is trained on an easier problem
---------------------------------------------------------------------
THE DEFECT. Stage B learns quantiles of M_up/sigma conditioned on log sigma,
and `sigma` in training is RV -- the REALIZED window volatility. At serving it
is the model's own forecast. So the target fitted is not the target faced, and
dividing by the realized value silently removes the volatility-forecast error
from the problem. Measured on the production slice:

    sd( M_up / RV_true   ) = 0.5490     <- what training fits
    sd( M_up / sigma_hat ) = 0.9312     <- what serving faces, 1.7x wider

Stage B is therefore fitted to a distribution 40% narrower than the one its
output is applied to, and its quantiles are correspondingly too tight.

It is worse than a scale mismatch. RV appears in the DENOMINATOR of the target
and in the CONDITIONER. Noise in RV alone induces dependence between them:
permuting RV -- which destroys every economic relationship it has with M_up --
still leaves Spearman(log RV, M_up/RV) = -0.4331. That is Pearson's spurious
correlation of ratios (1897), and nothing stops stage B fitting it. The
observed training-regime correlation is -0.0556, i.e. the real relationship is
SMALLER than the arithmetic artifact sitting on top of it.

THE FIX. Train stage B against a volatility reference that FITS NOTHING, so
there is no estimator that could leak: exp(har_1d) * sqrt(H), where har_1d is a
FEATURE built from bars strictly before the anchor. Clip bounds are quantiles
of that forecast on the fold's TRAINING episodes only.

    sd( M_up / sigma_causal ) = 0.9272   <- reproduces the serving regime

It is a WEAKER forecast than the deployed one, which makes the arm conservative
rather than flattering.

(An earlier version of this fix cross-fitted an OLS over time blocks and is
DISCARDED. Ordinary K-fold fits each held-out block on every OTHER block,
including LATER ones, so a 2021 episode's sigma was computed partly from 2025
data. That run was 5/6 positive and is not reported. See
causal_sigma_factory().)

---------------------------------------------------------------------
ARM 2 -- uniqueness: PROVABLY VACUOUS HERE, and that is the finding
---------------------------------------------------------------------
The redundancy is real. Average uniqueness puts the effective sample size at
8,380 against 510,496 episodes -- a 60.9x inflation, with 19,134 parameters
fitted to it.

The standard remedy does not apply, and not as a matter of degree. Measured on
the training split (n = 189,831):

    uniqueness   mean 0.016393   sd 0.000000   CV 0.0000
    concurrency  mean 60.9       max 61
    normalised weight multiplier: min 1.0000, max 1.0000, sd 0.0000

Every episode ON THE TRAINING SPLIT has uniqueness EXACTLY 1/61, at every
horizon, and the training split is the only place the weights are applied.

The reason is structural. Our episodes are generated on a COMPLETE REGULAR GRID
-- every hour, every horizon -- so the concurrency count c(t) is a constant of
the grid rather than a property of the data, uniqueness is its reciprocal, and
after normalisation the weights are uniform up to floating point. The arm
essentially cannot change the fit.

It was run anyway, and the measured difference is 1e-5 in DSC/UNC against the
4e-3 that serve_consistent moves -- about 100x smaller, and not in a consistent
direction (3 folds up, 3 down). NOT bit-for-bit, and an earlier version of this
file wrongly said so while the table two sections down showed 0.04980 against
0.04981. Two reasons it is not exact: the walk-forward training windows include
the sample-start boundary where the grid is not yet full, and `w * c / mean(w *
c)` is not bitwise identity even for constant c.

Across the FULL episode set the CV is 0.032 rather than 0, entirely from the
first and last days where the grid is not yet full. The diagnostic prints the
full-set figure, so the two numbers are not in conflict.

This is worth stating because average uniqueness and the sequential bootstrap
(Lopez de Prado 2018) were recommended to us for exactly this problem. They are
built for EVENT-DRIVEN labels -- triple-barrier sampling with data-dependent
holding periods -- where concurrency genuinely varies episode to episode. On a
regular grid there is nothing for them to grip: uniqueness weighting is a
RELATIVE reweighting and the redundancy here is UNIFORM.

So the redundancy has to be attacked by removing samples or by shrinking
capacity, not by reweighting. Which is what ARM 3 tests.

---------------------------------------------------------------------
ARM 3 -- nonoverlap: does the augmentation help at all?
---------------------------------------------------------------------
The cleanest test of the same question, and one nothing in this repo has run:
train ONLY on non-overlapping episodes (H=19 at 17:00, one per day, ~2.5k) and
compare. If the 200x larger overlapping set is not buying anything, that is
worth knowing -- it would mean the model's capacity should be set against 2,500
observations, not 510,000.

---------------------------------------------------------------------
WHAT WOULD MAKE ANY OF THESE REAL
---------------------------------------------------------------------
Six expanding walk-forward folds, three seeds, identical everything else,
scored on the production slice. Paired by fold. The headline is DSC/UNC --
barrier discrimination, the one metric BENCHMARK.md section 2 says the
committee does NOT win, and the only one worth moving. Proper scores are
reported alongside so an arm cannot buy discrimination by wrecking the
distribution.

n = 6. "t-like" is mean/se of the paired fold differences and is descriptive;
six points do not support a p-value and none is quoted.

    python -m model.eval.training_methods
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

from noctua import baselines as B                                   # noqa: E402
from noctua import splits as S                                      # noqa: E402
from noctua.model import BASE_COLS                                  # noqa: E402
from noctua.train import load_all                                   # noqa: E402

from .benchmark import run_fold                                     # noqa: E402
from .efficiency import paired, summarise                           # noqa: E402


def average_uniqueness(ep: pd.DataFrame) -> np.ndarray:
    """Fraction of an episode's span not shared with concurrent episodes.

    concurrency c(t) = how many episodes cover hour t; an episode's uniqueness
    is the mean of 1/c(t) over its own span. An episode alone in its window
    scores 1.0; one of eighty overlapping windows scores about 1/80.

    Computed with a difference array and a prefix sum rather than a loop over
    510,000 episodes, which is the difference between a second and an hour.
    """
    start = ep["anchor_ts"].to_numpy(np.int64) // 3600
    span = ep["H"].to_numpy(np.int64)
    start = start - start.min()
    end = start + span
    n_hours = int(end.max()) + 1

    diff = np.zeros(n_hours + 1, np.float64)
    np.add.at(diff, start, 1.0)
    np.add.at(diff, end, -1.0)
    conc = np.cumsum(diff)[:n_hours]
    inv = np.where(conc > 0, 1.0 / np.maximum(conc, 1.0), 0.0)
    cum = np.concatenate([[0.0], np.cumsum(inv)])
    return (cum[end] - cum[start]) / np.maximum(span, 1)


def causal_sigma_factory(ep: pd.DataFrame, X: pd.DataFrame):
    """A stage-B denominator that CANNOT leak, and a correction to what came before.

    The first version of this cross-fitted an OLS over time blocks and fitted
    each held-out block on every OTHER block -- including LATER ones. That is
    ordinary K-fold, and ordinary K-fold is not causal for a time series: the
    sigma attached to a 2021 training episode was computed partly from 2025
    data, so the `serve_consistent` arm was optimistically biased and its first
    run is not reportable. Caught in review, and the run was discarded.

    The replacement fits nothing at all. `har_1d` is a FEATURE -- log hourly
    realized vol over the day BEFORE the anchor -- so
    exp(har_1d) * sqrt(H) is a volatility forecast that is causal by
    construction. No estimator, no folds, nothing to leak.

    It still needs clipping: the raw trailing estimate has a near-zero tail
    that drives sd(M_up/sigma) to 315.8. The clip bounds are quantiles of the
    forecast on the FOLD'S TRAINING EPISODES ONLY, which is why this is a
    factory rather than an array -- the bounds have to be refitted per fold to
    stay causal.

    Measured, with bounds from the training split (clip [0.005, 0.995]):

        sd( M_up / RV_true       ) = 0.5490   <- the skewed default
        sd( M_up / sigma_causal  ) = 0.9272   <- this
        sd( M_up / sigma_served  ) = 0.9312   <- what serving actually faces

    i.e. it reproduces the serving regime almost exactly, and does so with a
    weaker forecast than the deployed one, which makes the arm conservative
    rather than flattering.
    """
    H = ep["H"].to_numpy(np.float64)
    raw = np.exp(X["har_1d"].to_numpy(np.float64)) * np.sqrt(H)

    def fn(train_mask: np.ndarray) -> np.ndarray:
        lo, hi = np.quantile(raw[train_mask], [0.005, 0.995])
        return np.maximum(np.clip(raw, lo, hi), 1e-12)

    return fn


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="How should this model be trained?")
    ap.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--hidden", type=int, default=32)
    ap.add_argument("--out", type=Path,
                    default=Path("model/artifacts/training_methods.json"))
    a = ap.parse_args(argv)

    ep, X = load_all(a.artifacts)
    fin = np.isfinite(X.to_numpy()).all(1)

    uniq = average_uniqueness(ep)
    sigma_fn = causal_sigma_factory(ep, X)
    prod = S.production_mask(ep)
    rv = ep.RV.to_numpy(np.float64)

    print("diagnostics on the full episode set")
    print(f"  average uniqueness: median {np.median(uniq):.5f}  "
          f"=> {uniq.sum():,.0f} effective from {len(ep):,} episodes "
          f"({len(ep)/max(uniq.sum(),1):.1f}x inflation)")
    # If this is ~0 the uniqueness arm is a no-op BY CONSTRUCTION -- a regular
    # episode grid gives constant concurrency, hence constant uniqueness. Say
    # so loudly rather than letting a vacuous arm sit in the table looking like
    # an experimental null.
    cv = float(uniq.std() / max(uniq.mean(), 1e-12))
    print(f"  uniqueness CV: {cv:.6f}"
          + ("   <- CONSTANT: reweighting is vacuous on a regular grid"
             if cv < 1e-6 else ""))
    m = prod & fin
    sig_dx = sigma_fn(S.time_splits(ep)["train"] & fin)     # diagnostics only
    print(f"  causal sigma / RV on production: median "
          f"{np.median(sig_dx[m]/rv[m]):.4f}")
    print(f"  sd(M_up/RV)={np.std(np.abs(ep.M_up.to_numpy()[m])/rv[m]):.4f}  "
          f"sd(M_up/sigma_causal)={np.std(np.abs(ep.M_up.to_numpy()[m])/sig_dx[m]):.4f}"
          f"   (serving faces ~0.93)")
    print(f"  non-overlapping training episodes available: {(prod & fin).sum():,}\n")

    arms = {
        "baseline":         dict(),
        "serve_consistent": dict(sigma_ref_fn=sigma_fn),
        "uniqueness":       dict(extra_w=uniq),
        # capacity/threshold relaxed only because this arm HAS less data --
        # that is the point of it, not a concession.
        "nonoverlap":       dict(train_filter=prod, min_train=500),
    }

    folds = S.walk_forward_folds(ep)
    print(f"{len(folds)} folds x {len(arms)} arms x {a.seeds} seeds\n")

    recs: list[dict] = []
    for f in folds:
        line = {"year": f["year"]}
        for name, kw in arms.items():
            t0 = time.time()
            out = run_fold(ep, X, f, hidden=a.hidden, seeds=a.seeds, **kw)
            if out is None:
                print(f"  {f['year']}  {name:17} SKIPPED (insufficient data)")
                continue
            s = summarise(out["rows"])
            s["qlike"] = out["vol"]["noctua"]
            s["DSS_har"] = summarise(out["rows"], "log_har_gauss")["DSS"]
            line[name] = s
            print(f"  {f['year']}  {name:17} DSC/UNC {s['DSS']:.5f}  "
                  f"pinball {s['pinball']:.6f}  CRPS {s['crps']:.6f}  "
                  f"QLIKE {s['qlike']:.4f}  ({time.time()-t0:.0f}s)", flush=True)
        if all(k in line for k in arms):
            recs.append(line)

    if not recs:
        print("no fold produced every arm")
        return 1

    print(f"\n{'arm':>17} {'DSC/UNC':>9} {'vs base':>9} {'wins':>6} "
          f"{'t-like':>7} {'pinball':>9} {'CRPS':>9} {'QLIKE':>8}")
    base = {k: np.array([r["baseline"][k] for r in recs])
            for k in ("DSS", "pinball", "crps", "qlike")}
    report = {}
    for name in arms:
        cur = {k: np.array([r[name][k] for r in recs])
               for k in ("DSS", "pinball", "crps", "qlike")}
        p = paired(cur["DSS"] - base["DSS"])
        report[name] = {"DSS": float(cur["DSS"].mean()),
                        "pinball": float(cur["pinball"].mean()),
                        "crps": float(cur["crps"].mean()),
                        "qlike": float(cur["qlike"].mean()),
                        "vs_baseline_DSS": p}
        tag = "" if name == "baseline" else f"{100*(cur['DSS'].mean()/base['DSS'].mean()-1):+8.1f}%"
        wins = "" if name == "baseline" else f"{p['wins']}/{len(recs)}"
        tl = "" if name == "baseline" else f"{p['t_like']:+7.2f}"
        print(f"{name:>17} {cur['DSS'].mean():9.5f} {tag:>9} {wins:>6} {tl:>7} "
              f"{cur['pinball'].mean():9.6f} {cur['crps'].mean():9.6f} "
              f"{cur['qlike'].mean():8.4f}")

    har = np.array([r["baseline"]["DSS_har"] for r in recs]).mean()
    print(f"\n  reference -- log_har_gauss DSC/UNC {har:.5f}")
    for name in arms:
        print(f"    {name:17} {100*(report[name]['DSS']/har-1):+6.1f}% vs log_har")
    print("\n  n = 6 folds; 't-like' is descriptive, not a p-value.")

    a.out.write_text(json.dumps({"seeds": a.seeds, "hidden": a.hidden,
                                 "log_har_DSS": float(har),
                                 "summary": report, "folds": recs},
                                indent=2, default=float) + "\n")
    print(f"\nwritten -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
