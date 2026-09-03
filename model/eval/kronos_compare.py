"""
eval/kronos_compare.py
=====================================================================
Score Kronos against NOCTUA on identical episodes, by one implementation of
one set of rules.

Kronos's raw per-episode probabilities come from data/kronos_predictions.json,
produced by eval/kronos_ci.py on a GitHub runner (huggingface.co weight
downloads are 403-blocked from the development container). NOCTUA is run here
on episodes matched by `anchor_ts`, so both models answer exactly the same
questions about exactly the same nights.

Neither model grades itself. Both are scored by the functions in this file,
which are the same rules eval/benchmark.py uses:

  * Brier and log score -- strictly proper, so calibration alone cannot win;
  * the CORP decomposition, whose DSC term is 0 by construction for any
    constant forecaster and therefore cannot be faked.

`climatology` is included as the same adversarial control used throughout this
repo. Its DSC must come out at exactly 0.000000; if it does not, the harness
is broken and no other number in the table means anything.

A NOTE ON WHAT A LOSS WOULD MEAN

Kronos-small is 24.7M parameters against NOCTUA's 19,134 -- roughly 1,300x.
Losing to it would be an entirely ordinary outcome and will be reported as
plainly as a win. What would NOT be acceptable is quietly reporting only the
metrics NOCTUA happens to win, so every metric computed here is printed.

    python -m model.eval.kronos_compare
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

from noctua.features import build_features                          # noqa: E402
from serve.history import load_bundle                               # noqa: E402
from serve.runtime import load_model                                # noqa: E402

H = 19
# Mirrors kronos_ci.LOOKBACK_HOURS: reg_rv_vs_year looks back 365 days, so an
# anchor is only scorable once the bundle reaches a year behind it.
LOOKBACK_HOURS = 24 * 370


def corp(p: np.ndarray, y: np.ndarray) -> dict:
    """S = MCB - DSC + UNC, calibrated by isotonic regression (bin-free)."""
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    y = np.asarray(y, float)
    base = float(y.mean())
    pc = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip").fit_transform(p, y)
    s_raw = float(np.mean((p - y) ** 2))
    s_cal = float(np.mean((pc - y) ** 2))
    s_ref = float(np.mean((base - y) ** 2))
    return {"brier": s_raw, "MCB": s_raw - s_cal, "DSC": s_ref - s_cal, "UNC": s_ref,
            "log_score": float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Kronos vs NOCTUA, one scorer")
    ap.add_argument("--kronos", type=Path, default=Path("data/kronos_predictions.json"))
    # Must match kronos_ci.py's --bundle. See the note at the load site.
    ap.add_argument("--bundle", type=Path,
                    default=Path("data/assets/btc_history.parquet"))
    ap.add_argument("--out", type=Path, default=Path("model/artifacts/kronos_vs_noctua.json"))
    a = ap.parse_args(argv)

    if not a.kronos.exists():
        print(f"{a.kronos} not found -- run the kronos-eval workflow first.")
        print("Kronos weights are not reachable from this container (HF 403);")
        print("the run happens on a GitHub runner and commits its predictions.")
        return 1

    kd = json.loads(a.kronos.read_text())
    eps = kd["episodes"]
    barriers = np.array(kd["barrier_pct"], dtype=float)
    bu = np.log1p(barriers / 100.0)
    print(f"Kronos {kd['model']} -- {kd['n_episodes']} episodes, "
          f"{kd['samples_per_episode']} paths each")
    print(f"  wall clock {kd['total_seconds']:.0f}s "
          f"({kd['seconds_per_episode']:.2f}s/episode)\n")

    # ---- NOCTUA on the SAME anchors ---------------------------------------
    model = load_model()
    # THE SAME BUNDLE kronos_ci.py ran on, not the serving bundle.
    #
    # This defaulted to load_bundle() -- the ~400-day SERVING bundle -- while
    # kronos_ci.py runs on the 900-day harvested one. Both models then answer
    # the same anchors, but NOCTUA's build_features needs 365 days of lookback
    # WITHIN the bundle it is given, so a 400-day bundle leaves only its last
    # ~30 anchors with finite features. The result was a head-to-head that
    # matched 117 of 120 anchors and then scored 35 of them, silently, with the
    # loss appearing as an `np.isfinite` filter rather than as an error.
    #
    # kronos_ci.py's docstring already names this exact trap and was fixed for
    # it; this file was not. Same bundle on both sides, or the comparison
    # throws away two thirds of a run that costs three and a half hours.
    hours = load_bundle(a.bundle)
    if len(hours) < LOOKBACK_HOURS + 24:
        print(f"  bundle has {len(hours)} hours; features need "
              f"{LOOKBACK_HOURS} of lookback before the first scorable anchor")
    ts_all = hours["hour_ts"].to_numpy(np.int64)
    want = np.array([e["anchor_ts"] for e in eps], dtype=np.int64)
    rows = np.searchsorted(ts_all, want)
    keep = (rows < len(hours)) & (ts_all[np.clip(rows, 0, len(hours) - 1)] == want)
    if keep.sum() < len(want):
        print(f"  matched {keep.sum()}/{len(want)} anchors in the bundle")
    eps = [e for e, k in zip(eps, keep) if k]
    rows = rows[keep]

    dt = pd.to_datetime(ts_all[rows], unit="s", utc=True)
    ep_df = pd.DataFrame({"anchor_ts": ts_all[rows], "H": H, "row": rows, "dt": dt,
                          "anchor_hour": dt.hour, "dow": dt.dayofweek})
    X = build_features(hours, ep_df)
    ok = np.isfinite(X.to_numpy()).all(1)
    X, ep_df, rows = X[ok], ep_df[ok], rows[ok]
    eps = [e for e, k in zip(eps, ok) if k]
    # Loud, because the failure this catches is silent by nature: episodes
    # vanish through an np.isfinite filter, the run still prints a tidy table,
    # and the only symptom is that the table was computed on a third of the
    # data that three and a half hours of compute produced.
    if len(eps) < 0.8 * kd["n_episodes"]:
        print(f"  WARNING: only {len(eps)} of {kd['n_episodes']} Kronos episodes "
              f"are scorable.\n  NOCTUA's features need {LOOKBACK_HOURS}h "
              f"({LOOKBACK_HOURS//24}d) of lookback inside --bundle "
              f"({len(hours)}h available).\n  Check that --bundle matches the "
              f"one kronos_ci.py ran on.")
    print(f"  scoring {len(eps)} episodes both models answered\n")

    pred = model.predict(model.prepare(X, ep_df.H.to_numpy(np.float64)))

    M_up = np.array([e["M_up"] for e in eps])
    M_dn = np.array([e["M_dn"] for e in eps])
    RV = np.array([e["RV"] for e in eps])
    k_up = np.array([e["p_up_barrier"] for e in eps])
    k_dn = np.array([e["p_dn_barrier"] for e in eps])
    k_sig = np.array([e["sigma"] for e in eps])
    n_sam = kd["samples_per_episode"]

    rowsout = []
    P_noctua, P_kronos, Y_all = [], [], []      # kept for the controls below
    for j, pct in enumerate(barriers):
        for side, M, kp in (("up", M_up, k_up), ("dn", M_dn, k_dn)):
            y = (M >= bu[j]).astype(float)
            if y.mean() <= 0 or y.mean() >= 1:
                continue
            npv = model.touch_prob(pred, np.full(len(eps), bu[j]), side == "up")
            # A generative model's probability is granular at 1/n_samples and
            # can be exactly 0; nudge inside the open interval so the log score
            # is finite. This HELPS Kronos and is applied only to Kronos.
            kpv = np.clip(kp[:, j], 0.5 / n_sam, 1 - 0.5 / n_sam)
            const = np.full(len(eps), float(y.mean()))
            P_noctua.append(npv); P_kronos.append(kpv); Y_all.append(y)
            for name, p in (("noctua", npv), ("kronos", kpv), ("climatology", const)):
                rowsout.append({"barrier_pct": float(pct), "side": side,
                                "model": name, **corp(p, y)})

    df = pd.DataFrame(rowsout)
    agg = df.groupby("model")[["brier", "log_score", "DSC", "MCB", "UNC"]].mean()
    agg = agg.reindex(["noctua", "kronos", "climatology"])

    print("=" * 72)
    print("HEAD-TO-HEAD, pooled over barriers and sides")
    print("=" * 72)
    print(agg.round(6).to_string())

    dsc_noctua = float(agg.loc["noctua", "DSC"])
    dsc_kronos = float(agg.loc["kronos", "DSC"])
    c_dsc = float(agg.loc["climatology", "DSC"])
    print(f"\nsanity: climatology DSC = {c_dsc:.8f} "
          f"({'OK, harness sound' if abs(c_dsc) < 1e-9 else 'BROKEN -- ignore every number above'})")

    print("\nPer barrier (upside), DSC -- higher is better:")
    piv = df[df.side == "up"].pivot_table(index="barrier_pct", columns="model", values="DSC")
    print(piv.round(6).to_string())

    print("\nVolatility, median predicted / realized (1.00 = unbiased):")
    print(f"  noctua {np.median(pred['sigma_med'] / np.maximum(RV, 1e-12)):.3f}")
    print(f"  kronos {np.median(k_sig / np.maximum(RV, 1e-12)):.3f}")

    n_par = model.meta.get("n_params_total", 0)
    print(f"\nparameters: noctua {n_par:,}   kronos ~24,700,000 "
          f"({24_700_000 / max(n_par, 1):.0f}x larger)")

    verdict = []
    for m in ("brier", "log_score"):
        w = "noctua" if agg.loc["noctua", m] < agg.loc["kronos", m] else "kronos"
        verdict.append(f"{m}: {w}")
    w = "noctua" if agg.loc["noctua", "DSC"] > agg.loc["kronos", "DSC"] else "kronos"
    verdict.append(f"DSC: {w}")
    print("\nwinner by metric -> " + ", ".join(verdict))

    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(
        {"kronos_meta": {k: v for k, v in kd.items() if k != "episodes"},
         "n_scored": len(eps), "per_barrier": rowsout,
         "pooled": json.loads(agg.to_json(orient="index"))}, indent=2, default=float) + "\n")
    # ------------------------------------------------------------------
    # TWO CONTROLS THE FIRST VERSION OF THIS FILE DID NOT HAVE
    # ------------------------------------------------------------------
    print("\n" + "=" * 72)
    print("CONTROLS")
    print("=" * 72)

    # (1) THE DSC NOISE FLOOR.
    #
    # Climatology scoring DSC = 0.000000 is a weaker check than it looks.
    # A CONSTANT forecaster is pinned to zero by construction, so it cannot
    # reveal discrimination MANUFACTURED by the scorer. CORP fits its isotonic
    # regression on the same 120 outcomes it then scores, so any forecaster
    # with variation -- including one whose ordering is pure noise -- collects
    # some positive DSC from that in-sample fit.
    #
    # The right control keeps each model's marginal distribution of forecasts
    # intact and destroys only its ALIGNMENT with the outcomes. Whatever DSC
    # survives that is the floor, and a real DSC has to clear it.
    rng = np.random.default_rng(0)
    floor = {}
    for name, P in (("noctua", P_noctua), ("kronos", P_kronos)):
        vals = []
        for _ in range(200):
            perm = rng.permutation(len(Y_all[0]))
            vals.append(np.mean([corp(p[perm], y)["DSC"]
                                 for p, y in zip(P, Y_all)]))
        floor[name] = (float(np.mean(vals)), float(np.quantile(vals, 0.95)))
    print("\nshuffled control -- predictions permuted against outcomes:")
    print(f"{'model':>10} {'real DSC':>10} {'shuffled mean':>14} {'shuffled p95':>13} {'clears?':>9}")
    for name, real in (("noctua", dsc_noctua), ("kronos", dsc_kronos)):
        mu, p95 = floor[name]
        print(f"{name:>10} {real:10.6f} {mu:14.6f} {p95:13.6f} "
              f"{'YES' if real > p95 else 'NO':>9}")

    # (2) SERIAL DEPENDENCE.
    #
    # The episodes are consecutive days and volatility clusters, so adjacent
    # score differences are correlated. An IID bootstrap over episodes ignores
    # that and reports intervals that are too narrow -- which is how the first
    # version of this comparison produced P(better) = 1.000. A moving-block
    # bootstrap resamples CONTIGUOUS runs of days and keeps the dependence.
    n = len(Y_all[0])
    L = max(2, int(round(n ** (1 / 3))))          # standard n^(1/3) block length
    nb = int(np.ceil(n / L))
    def block_idx(g):
        st = g.integers(0, max(n - L, 1), nb)
        return np.concatenate([np.arange(s, s + L) for s in st])[:n] % n
    g = np.random.default_rng(1)
    db, dd = [], []
    for _ in range(2000):
        i = block_idx(g)
        db.append(np.mean([((pk[i] - y[i]) ** 2).mean() - ((pn[i] - y[i]) ** 2).mean()
                           for pn, pk, y in zip(P_noctua, P_kronos, Y_all)]))
        dd.append(np.mean([corp(pn[i], y[i])["DSC"] - corp(pk[i], y[i])["DSC"]
                           for pn, pk, y in zip(P_noctua, P_kronos, Y_all)]))
    db, dd = np.array(db), np.array(dd)
    print(f"\nmoving-block bootstrap, block length {L} days, 2000 resamples:")
    print(f"  Brier advantage to NOCTUA  {np.percentile(db,2.5):+.6f} .. "
          f"{np.percentile(db,97.5):+.6f}   P(better) {(db>0).mean():.3f}")
    print(f"  DSC   advantage to NOCTUA  {np.percentile(dd,2.5):+.6f} .. "
          f"{np.percentile(dd,97.5):+.6f}   P(better) {(dd>0).mean():.3f}")

    print(f"\nwritten -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
