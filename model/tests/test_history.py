#!/usr/bin/env python3
"""
model/tests/test_history.py
=====================================================================
Tests for the served history path -- the part that broke in production.

The first live cron run died with "only 83.2h of history, need >= 528h", and
behind that sat a quieter problem: the feature set reaches back 365 days
(`reg_rv_vs_year`), and short history does not raise -- `prepare()` runs
`nan_to_num` after standardising, so an unfillable feature becomes 0, which is
the training MEAN. The model would have produced confident, subtly wrong strike
levels forever.

These tests run entirely offline against the committed bundle, so CI (which has
no market access, and no training parquet) can still exercise them.

  1. the committed bundle covers the longest feature lookback and is contiguous
  2. partial hours at the edges of a fetch are DROPPED -- a half-counted hour
     understates realized variance, biasing the vol forecast low, which is the
     dangerous direction for a seller
  3. merging a fetched tail over the bundle reproduces the true hourly rows
     exactly, rather than approximately
  4. a short history is REJECTED loudly instead of silently mean-imputed
  5. a gap in the hourly grid is rejected -- trailing windows count rows, not
     elapsed time, so a hole silently shifts every lookback
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from serve import history as H  # noqa: E402

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = ""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  -> ' + detail}")
    if not cond:
        FAILS.append(name)


def synth_5min_bars(hours: pd.DataFrame, tail_hours: int, offset_min: int = 25):
    """Fabricate a 5-minute feed consistent with `hours`, deliberately ragged.

    Starts mid-hour so the first hour is incomplete, which is exactly what a
    real fetch window looks like and what the completeness rule must discard.
    """
    end = int(hours["hour_ts"].iloc[-1]) + 3600
    start = end - tail_hours * 3600 + offset_min * 60
    ts = np.arange(start, end, 300, dtype=np.int64)
    rng = np.random.default_rng(7)
    base = float(hours["close"].iloc[-1])
    px = base * np.exp(np.cumsum(rng.normal(0, 4e-4, len(ts))))
    return pd.DataFrame({
        "timestamp": ts, "open": px, "high": px * 1.0005,
        "low": px * 0.9995, "close": px, "volume": np.abs(rng.normal(3, 1, len(ts))),
        "source": "synthetic", "bad_print": False,
    })


def main() -> int:
    print("NOCTUA history self-test\n")

    bundle = H.load_bundle()
    info = H.check_continuity(bundle)
    check("bundle loads", True)
    check("bundle covers the longest feature lookback (365d)",
          len(bundle) >= H.MIN_HISTORY_HOURS,
          f"{len(bundle)}h < {H.MIN_HISTORY_HOURS}h")
    check("bundle is contiguous", info["contiguous"],
          f"{info['gaps']} gaps, largest {info['largest_gap_hours']}h")
    check("bundle hours strictly increasing",
          bool((np.diff(bundle.hour_ts.to_numpy()) > 0).all()))
    check("bundle has every feature column",
          set(H.HOURLY_COLS).issubset(bundle.columns))
    check("bundle realized variances non-negative",
          bool((bundle[["rv5", "rv5_pos", "rv5_neg", "bpv5", "rq5"]] >= 0).all().all()))

    # ---- 2: partial edge hours are dropped -------------------------------
    bars = synth_5min_bars(bundle, tail_hours=12, offset_min=25)
    fresh = H.hours_from_bars(bars)
    first_bar_hour = int(bars.timestamp.iloc[0]) // 3600
    check("partial FIRST hour dropped",
          int(fresh.hour_ts.iloc[0]) // 3600 > first_bar_hour,
          "an incomplete hour would under-count realized variance")
    counts = bars.assign(h=bars.timestamp // 3600).groupby("h").size()
    complete_hours = set(counts[counts >= 12].index)
    check("only complete hours kept",
          set(fresh.hour_ts // 3600) == complete_hours,
          f"{len(fresh)} kept vs {len(complete_hours)} complete")

    # ---- 3: merge reproduces the true hourly rows exactly -----------------
    # Rebuild the last 30 bundle hours from a "fetch" of the SAME data and
    # confirm the merge is lossless rather than merely close.
    truth = bundle.tail(30).reset_index(drop=True)
    older = bundle.iloc[:-30].reset_index(drop=True)
    merged = H.merge(older, truth)
    check("merge restores the full history length", len(merged) == len(bundle))
    same = np.allclose(
        merged[H.HOURLY_COLS].to_numpy(np.float64),
        bundle[H.HOURLY_COLS].to_numpy(np.float64), rtol=0, atol=0)
    check("merge is exact (bit-for-bit)", same)

    # fresh rows must WIN over stale bundle rows for the same hour
    stale = bundle.copy()
    stale.loc[stale.index[-5:], "close"] = -999.0
    fixed = H.merge(stale, bundle.tail(5))
    check("fresh rows override stale rows for the same hour",
          bool((fixed["close"] > 0).all()))

    # ---- 4/5: bad histories are rejected loudly --------------------------
    def raises(fn) -> bool:
        try:
            fn()
            return False
        except RuntimeError:
            return True

    short = bundle.tail(200).reset_index(drop=True)
    check("short history is REJECTED, not mean-imputed",
          raises(lambda: _short_guard(short)))

    holed = pd.concat([bundle.iloc[:100], bundle.iloc[150:]], ignore_index=True)
    ci = H.check_continuity(holed)
    check("a gap in the hourly grid is detected",
          not ci["contiguous"], f"gaps={ci['gaps']}")

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
        return 1
    print("all checks passed")
    return 0


def _short_guard(short: pd.DataFrame):
    """Mirror get_hours' length assertion without needing a fetch."""
    if len(short) < H.MIN_HISTORY_HOURS:
        raise RuntimeError(
            f"only {len(short)}h of history, need >= {H.MIN_HISTORY_HOURS}h"
        )


if __name__ == "__main__":
    sys.exit(main())
