"""
eval/kronos_ci.py
=====================================================================
Run Kronos on the committed BTC history, inside CI, and emit raw per-episode
touch probabilities for offline scoring.

WHY CI

Kronos weights live on huggingface.co, which the development container cannot
reach -- the egress proxy returns 403 on weight downloads and only the metadata
API is available through the MCP connector. This has left the head-to-head
unmeasured for the entire project, and every "better than Kronos" claim
carefully unmade. A GitHub runner has unrestricted access to both HF and PyPI,
which is the same observation that unblocked the cross-asset data. So Kronos
runs there, and the raw numbers are committed for scoring here.

The existing eval/kronos_baseline.py cannot do this: it needs the 160 MB
training parquet and the PyTorch checkpoint, neither of which is committed.
This script depends on nothing but a committed hourly bundle. It uses the
900-day harvested BTC bundle rather than the 400-day serving one, because
NOCTUA's features need 365 days of lookback and a 400-day bundle leaves only
~30 anchors that BOTH models can answer.

WHAT IT EMITS

Per episode: the anchor timestamp, Kronos's Monte-Carlo touch probability at a
fixed barrier grid on both sides, its implied window volatility, and the
REALIZED excursions. It deliberately does NOT score anything and does not run
NOCTUA. Scoring happens in eval/kronos_compare.py against episodes matched by
anchor_ts, so both models are graded by one implementation of one set of
rules, rather than each grading itself.

FAIRNESS

Kronos is given the same 512-hour context window NOCTUA's features are derived
from, and generous sampling -- more Monte-Carlo paths than this dashboard's own
retired kronos_local/app.py used. Sampling is how a generative model states a
probability, so this is its natural form and not a handicap. Wall clock is
recorded so the compute asymmetry is measured rather than asserted.

Fairness is not automatic, and it failed twice here. The obvious call --
`predict(sample_count=32)` -- silently AVERAGES its 32 draws and returns one
path, which made Kronos look 2.7x too calm and reduced its probabilities to 0/1
indicators. That was this harness's bug, not Kronos's behaviour. See
draw_paths() for the mechanism and assert_ensemble() for the guard that now
stops a collapsed ensemble in the first episode instead of the last.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

# Kronos's repository exposes a top-level package named `model`, which would
# collide with this repository's own `model/` directory. Its path goes on FIRST
# and the import happens before anything of ours touches sys.path.
KRONOS_REPO = os.environ.get("KRONOS_REPO", "")
if KRONOS_REPO:
    sys.path.insert(0, KRONOS_REPO)

H = 19
ANCHOR_UTC = 17
CONTEXT = 512
BARRIER_PCT = np.array([0.5, 1.0, 2.0, 3.0, 5.0])
BARRIER_U = np.log1p(BARRIER_PCT / 100.0)


def load_kronos(model_name: str, tokenizer_name: str, device: str = "cpu"):
    from model import Kronos, KronosPredictor, KronosTokenizer  # type: ignore

    tok = KronosTokenizer.from_pretrained(tokenizer_name)
    mdl = Kronos.from_pretrained(model_name)
    mdl.eval()
    return KronosPredictor(mdl, tok, device=device, max_context=CONTEXT)


# NOCTUA's reg_rv_vs_year feature looks back 365 days, so an anchor is only
# COMPARABLE once the bundle reaches a year behind it. Kronos itself needs just
# CONTEXT hours, but an episode Kronos can answer and NOCTUA cannot is useless
# for a head-to-head, so the stricter bound governs.
LOOKBACK_HOURS = 24 * 370


def production_anchors(hours: pd.DataFrame) -> np.ndarray:
    ts = hours["hour_ts"].to_numpy(np.int64)
    hh = pd.to_datetime(ts, unit="s", utc=True).hour
    rows = np.where(hh == ANCHOR_UTC)[0]
    return rows[(rows >= max(CONTEXT + 1, LOOKBACK_HOURS)) & (rows + H < len(hours))]


def realized(hours: pd.DataFrame, row: int) -> dict:
    logc = np.log(hours["close"].to_numpy(np.float64))
    logh = np.log(hours["high"].to_numpy(np.float64))
    logl = np.log(hours["low"].to_numpy(np.float64))
    rv5 = hours["rv5"].to_numpy(np.float64)
    base = logc[row - 1]
    sl = slice(row, row + H)
    return {
        "M_up": max(float(logh[sl].max() - base), 0.0),
        "M_dn": max(float(base - logl[sl].min()), 0.0),
        "RV": float(np.sqrt(rv5[sl].sum())),
        "R": float(logc[row + H - 1] - base),
    }


def draw_paths(predictor, x_df, x_ts, y_ts, n_samples: int,
               temperature: float, top_p: float) -> list:
    """Return n_samples INDEPENDENT rollouts.

    This is the subtle part, and getting it wrong invalidated two full CI runs.

    `KronosPredictor.predict(..., sample_count=N)` does NOT return N paths. It
    draws N and averages them before returning -- `kronos.py:467`,
    `preds = np.mean(preds, axis=1)`, and the `predict_batch` docstring says so
    outright: "Number of parallel samples per series, automatically averaged
    internally." What comes back is one smoothed conditional-mean path.

    Two things follow, and both are fatal to a probability forecast:

      * Averaging 32 rollouts cancels their independent components, so the
        surviving path's volatility is far below the process's. Measured:
        sampled sigma / realized RV had median 0.259 at top_p=0.9 and 0.373 at
        top_p=1.0. Neither was Kronos being wrong about volatility; both were
        this average.
      * With a single path there is no Monte-Carlo distribution at all. Every
        touch "probability" came out exactly 0.0 or 1.0 -- an indicator on the
        mean path. Scoring that against NOCTUA's calibrated curve would have
        been a comparison of a probability against a point forecast, and Kronos
        would have lost on a handicap I built for it.

    `predict_batch` with the same context repeated n_samples times and
    sample_count=1 gives what was wanted all along: n_samples separate rollouts,
    each returned intact, batched exactly as before so the compute is unchanged.
    """
    if hasattr(predictor, "predict_batch"):
        out = predictor.predict_batch(
            df_list=[x_df] * n_samples,
            x_timestamp_list=[x_ts] * n_samples,
            y_timestamp_list=[y_ts] * n_samples,
            pred_len=H, T=temperature, top_p=top_p,
            sample_count=1, verbose=False)
        if isinstance(out, list) and len(out) == n_samples:
            return out
    # Fallback for a Kronos without predict_batch: loop single draws. Slower --
    # no batching -- but still n_samples genuinely independent paths.
    return [predictor.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts,
                              pred_len=H, T=temperature, top_p=top_p,
                              sample_count=1, verbose=False)
            for _ in range(n_samples)]


def kronos_episode(predictor, hours: pd.DataFrame, row: int, n_samples: int,
                   temperature: float, top_p: float) -> dict:
    """Roll Kronos out n_samples times; reduce the paths to touch probabilities."""
    lo = row - CONTEXT
    ctx = hours.iloc[lo:row]
    x_df = pd.DataFrame({
        "open": ctx["open"].to_numpy(np.float64),
        "high": ctx["high"].to_numpy(np.float64),
        "low": ctx["low"].to_numpy(np.float64),
        "close": ctx["close"].to_numpy(np.float64),
        "volume": ctx["volume"].to_numpy(np.float64),
    })
    x_ts = pd.Series(pd.to_datetime(ctx["hour_ts"].to_numpy(), unit="s", utc=True))
    fut = hours["hour_ts"].to_numpy(np.int64)[row:row + H]
    y_ts = pd.Series(pd.to_datetime(fut, unit="s", utc=True))

    base = float(np.log(hours["close"].to_numpy(np.float64)[row - 1]))
    up_hits = np.zeros(len(BARRIER_U))
    dn_hits = np.zeros(len(BARRIER_U))
    sig_paths, up_paths = [], []

    paths = draw_paths(predictor, x_df, x_ts, y_ts, n_samples, temperature, top_p)

    for p in paths:
        hi = np.log(np.asarray(p["high"], dtype=np.float64))
        lo_ = np.log(np.asarray(p["low"], dtype=np.float64))
        cl = np.log(np.asarray(p["close"], dtype=np.float64))
        up_hits += ((hi.max() - base) >= BARRIER_U).astype(float)
        dn_hits += ((base - lo_.min()) >= BARRIER_U).astype(float)
        r = np.diff(np.concatenate([[base], cl]))
        sig_paths.append(float(np.sqrt((r ** 2).sum())))
        up_paths.append(float(cl[-1] > base))

    n = max(len(paths), 1)
    return {
        "p_up_barrier": (up_hits / n).tolist(),
        "p_dn_barrier": (dn_hits / n).tolist(),
        "sigma": float(np.median(sig_paths)) if sig_paths else float("nan"),
        # Dispersion ACROSS paths. The bug that invalidated the first two runs
        # collapsed the ensemble to one path, where this is exactly 0. Recording
        # it makes the failure visible in the output rather than only in the
        # touch probabilities, where it looked like miscalibration.
        "sigma_path_sd": float(np.std(sig_paths)) if len(sig_paths) > 1 else 0.0,
        "p_up": float(np.mean(up_paths)) if up_paths else float("nan"),
        "n_paths": int(n),
    }


def assert_ensemble(rec: dict, n_samples: int) -> None:
    """Fail in two minutes rather than three and a half hours.

    Both invalid runs looked healthy for their entire duration and were only
    caught by reading the output afterwards. These are the two signatures of a
    collapsed ensemble; either one means the numbers cannot be scored.
    """
    if rec["n_paths"] != n_samples:
        raise SystemExit(
            f"[kronos] ABORT: asked for {n_samples} paths, got {rec['n_paths']}. "
            "The predictor is averaging internally -- see draw_paths().")
    if rec["sigma_path_sd"] <= 0.0:
        raise SystemExit(
            "[kronos] ABORT: all sampled paths have identical volatility. "
            "The ensemble is degenerate and its touch probabilities would be "
            "0/1 indicators, not probabilities.")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Run Kronos in CI, emit raw predictions")
    # The 900-day harvested bundle, NOT the 400-day serving one. NOCTUA's
    # features need 365 days of lookback, so a 400-day bundle leaves only ~30
    # anchors it can score -- the first run produced 150 Kronos episodes of
    # which only 34 were comparable.
    p.add_argument("--bundle", type=Path,
                   default=Path("data/assets/btc_history.parquet"))
    p.add_argument("--kronos-model", default="NeoQuasar/Kronos-small")
    p.add_argument("--kronos-tokenizer", default="NeoQuasar/Kronos-Tokenizer-base")
    p.add_argument("--samples", type=int, default=32)
    p.add_argument("--episodes", type=int, default=150)
    p.add_argument("--temperature", type=float, default=1.0)
    # top_p=1.0, deliberately. Nucleus sampling truncates the tail of the
    # token distribution, which is precisely where large moves live. At 0.9 the
    # sampled paths came out with median volatility 0.377% against a realized
    # 1.467% -- a ratio of 0.259, four times too calm -- which depressed every
    # touch probability and made the comparison meaningless as a test of
    # Kronos. Truncation is wrong for a tail-sensitive task.
    p.add_argument("--top-p", type=float, default=1.0)
    p.add_argument("--out", type=Path, default=Path("data/kronos_predictions.json"))
    a = p.parse_args(argv)

    if not KRONOS_REPO:
        print("KRONOS_REPO is not set -- clone github.com/shiyu-coder/Kronos first")
        return 2

    hours = pd.read_parquet(a.bundle)
    rows = production_anchors(hours)[-a.episodes:]
    print(f"[kronos] {len(hours):,} hourly bars, {len(rows)} production episodes")
    print(f"[kronos] loading {a.kronos_model} + {a.kronos_tokenizer}", flush=True)

    t0 = time.time()
    predictor = load_kronos(a.kronos_model, a.kronos_tokenizer)
    load_sec = time.time() - t0
    print(f"[kronos] loaded in {load_sec:.1f}s", flush=True)

    ts = hours["hour_ts"].to_numpy(np.int64)
    records, t1 = [], time.time()

    def snapshot(done: bool):
        """Write what exists so far.

        Rollouts take hours. Writing only at the end means a timeout, an OOM
        or one bad episode discards the entire run, and the whole point of
        moving this to CI was that the compute is not cheap to repeat. A
        partial file with 120 episodes is a usable comparison; an empty one
        after 300 minutes is not.
        """
        a.out.parent.mkdir(parents=True, exist_ok=True)
        el = time.time() - t1
        a.out.write_text(json.dumps({
            "model": a.kronos_model, "tokenizer": a.kronos_tokenizer,
            "samples_per_episode": a.samples, "context_hours": CONTEXT,
            "H_hours": H, "barrier_pct": BARRIER_PCT.tolist(),
            "temperature": a.temperature, "top_p": a.top_p,
            "n_episodes": len(records), "complete": done,
            "episodes_requested": len(rows),
            "load_seconds": load_sec, "total_seconds": el,
            "seconds_per_episode": el / max(len(records), 1),
            "episodes": records,
        }, indent=2, default=float) + "\n")

    for i, row in enumerate(rows):
        try:
            k = kronos_episode(predictor, hours, int(row), a.samples,
                               a.temperature, a.top_p)
        except Exception as e:                                    # noqa: BLE001
            print(f"  episode {i} (row {row}) FAILED: {type(e).__name__}: {e}")
            continue
        rec = {"anchor_ts": int(ts[row]),
               "anchor_utc": str(pd.Timestamp(ts[row], unit="s", tz="UTC")),
               "row": int(row), **k, **realized(hours, int(row))}
        if not records:
            assert_ensemble(rec, a.samples)
            print(f"[kronos] ensemble check passed: {rec['n_paths']} paths, "
                  f"path-sigma sd {100 * rec['sigma_path_sd']:.4f}%", flush=True)
        records.append(rec)
        if i % 10 == 0:
            el = time.time() - t1
            print(f"  {i+1}/{len(rows)}  {el:.0f}s elapsed  "
                  f"{el/max(i+1,1):.2f}s/episode", flush=True)
        if len(records) % 20 == 0:
            snapshot(False)

    total = time.time() - t1
    snapshot(True)
    payload = {
        "model": a.kronos_model, "tokenizer": a.kronos_tokenizer,
        "samples_per_episode": a.samples, "context_hours": CONTEXT,
        "H_hours": H, "barrier_pct": BARRIER_PCT.tolist(),
        "temperature": a.temperature, "top_p": a.top_p,
        "n_episodes": len(records),
        "load_seconds": load_sec, "total_seconds": total,
        "seconds_per_episode": total / max(len(records), 1),
        "episodes": records,
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(payload, indent=2, default=float) + "\n")
    print(f"\n[kronos] {len(records)} episodes in {total:.0f}s "
          f"({total/max(len(records),1):.2f}s each) -> {a.out}")
    return 0 if records else 1


if __name__ == "__main__":
    sys.exit(main())
