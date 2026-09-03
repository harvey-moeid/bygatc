"""
serve/history.py
=====================================================================
The hourly history the features actually need, and how it stays current.

WHY THIS EXISTS (the bug it fixes)
-----------------------------------
The first live cron run failed with:

    fetch_bitstamp: only 83.2h of history, need >= 528h
    fetch_binance:  HTTP Error 451

Both errors were real, and behind them sat a worse one. `LOOKBACK_HOURS` was
set to 23 days on the assumption that the longest feature window was the
22-day HAR term. It is not. The feature set reaches back much further:

    mom_dist_ma100      2400 h   (100 days)
    mom_drawdown_90d    2160 h   ( 90 days)
    reg_rv_vs_year      8760 h   (365 days)

365 days of 5-minute bars is 105,120 candles -- about 105 paginated Bitstamp
requests per forecast. That is not a thing you do every 30 minutes.

And the failure mode had teeth: `prepare()` runs `nan_to_num` after
standardising, so a feature with insufficient history becomes 0, which is
exactly the training MEAN. Had the fetch "succeeded" with 23 days, the model
would have run happily with four long-lookback features silently pinned to
their training means -- train/serve skew, invisible, on a model whose output is
a strike price.

THE FIX
-------
Ship the long history as a committed hourly bundle and fetch only the tail.

    data/noctua_history.parquet   ~400 days of hourly aggregates (~716 KB)
    live fetch                    the tail since the bundle ends (usually 1 call)

The bundle carries the same hourly columns `noctua.features` consumes, built by
the same `build_hourly` code as training, so the served features are identical
in construction to the trained ones rather than merely similar. Every run
merges a freshly-fetched tail over the bundle in memory; the committed file is
rewritten only about weekly (see PERSIST_AFTER_HOURS), and the tail fetch grows
to cover whatever gap has accumulated.

Completeness rule: an hour is only accepted from the live feed if the fetch
contains all 12 of its 5-minute bars. Partial hours at either edge of the
fetch window would otherwise produce an under-counted realized variance, which
would quietly bias the volatility forecast low -- the single most dangerous
direction of error for an option seller.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua.episodes import build_hourly  # noqa: E402

HOUR = 3600
BARS_PER_HOUR = 12                     # 5-minute grid
BUNDLE_DAYS = 400

# How stale the committed bundle is allowed to get before it is rewritten.
#
# The cron runs every 30 minutes, but the bundle is ~716 KB of ALREADY-
# COMPRESSED parquet, so git cannot delta it -- every rewrite is a fresh blob.
# Committing on each run would add roughly 260 MB of objects per year to a repo
# whose entire current history is a few MB. Rewriting weekly costs ~37 MB/year
# instead, and the tail fetch simply covers whatever gap has accumulated (a
# week is ~2,016 five-minute bars, three requests).
PERSIST_AFTER_HOURS = 24 * 7

# Columns the feature builder needs from the hourly table.
HOURLY_COLS = [
    "hour_ts", "open", "high", "low", "close", "volume",
    "rv5", "rv5_pos", "rv5_neg", "bpv5", "rq5",
]

# The longest feature lookback, in hours. Anything shorter and features go
# silently to their training means (see module docstring).
MIN_HISTORY_HOURS = 365 * 24


def default_bundle_path() -> Path:
    return Path(__file__).resolve().parents[2] / "data" / "noctua_history.parquet"


def load_bundle(path: Path | None = None) -> pd.DataFrame:
    p = Path(path) if path else default_bundle_path()
    if not p.exists():
        raise FileNotFoundError(
            f"history bundle not found at {p}. Rebuild it with "
            f"`python -m noctua.make_bundle` from the training parquet."
        )
    df = pd.read_parquet(p)
    missing = set(HOURLY_COLS) - set(df.columns)
    if missing:
        raise ValueError(f"history bundle missing columns: {sorted(missing)}")
    return df.sort_values("hour_ts", ignore_index=True)


def save_bundle(hours: pd.DataFrame, path: Path | None = None, days: int = BUNDLE_DAYS) -> Path:
    p = Path(path) if path else default_bundle_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    out = hours[HOURLY_COLS].tail(days * 24).reset_index(drop=True)
    out.to_parquet(p, index=False, compression="zstd")
    return p


def hours_from_bars(bars: pd.DataFrame) -> pd.DataFrame:
    """Aggregate 5-minute bars to hourly, keeping only COMPLETE hours.

    `build_hourly` is the same function training used; it is exact on any input
    granularity dividing the 5-minute realized-variance grid (verified
    bit-for-bit against the 1-minute build).
    """
    b = bars.copy()
    if "bad_print" not in b.columns:
        b["bad_print"] = False
    hours = build_hourly(b)

    # count bars per hour so partial edge hours can be discarded
    counts = (
        bars.assign(_h=bars["timestamp"].to_numpy(np.int64) // HOUR)
        .groupby("_h")
        .size()
        .rename("n_bars")
    )
    hours = hours.merge(
        counts, left_on=(hours["hour_ts"] // HOUR), right_index=True, how="left"
    )
    hours["n_bars"] = hours["n_bars"].fillna(0).astype(int)
    complete = hours[hours["n_bars"] >= BARS_PER_HOUR].copy()
    return complete[HOURLY_COLS].sort_values("hour_ts", ignore_index=True)


def merge(bundle: pd.DataFrame, fresh: pd.DataFrame) -> pd.DataFrame:
    """Overlay freshly-fetched complete hours on top of the bundle."""
    if fresh.empty:
        return bundle.sort_values("hour_ts", ignore_index=True)
    both = pd.concat([bundle[HOURLY_COLS], fresh[HOURLY_COLS]], ignore_index=True)
    both = both.drop_duplicates(subset="hour_ts", keep="last")
    return both.sort_values("hour_ts", ignore_index=True)


def check_continuity(hours: pd.DataFrame, max_gap_hours: int = 2) -> dict:
    """A gap in the hourly grid corrupts every trailing-window feature.

    `features._trailing_sum` counts ROWS, not elapsed time, so a missing hour
    silently shifts every lookback window. Detect it rather than forecast
    through it.
    """
    ts = hours["hour_ts"].to_numpy(np.int64)
    gaps = np.diff(ts) // HOUR
    bad = int((gaps > 1).sum())
    return {
        "hours": int(len(hours)),
        "span_days": round(float((ts[-1] - ts[0]) / 86400.0), 2),
        "gaps": bad,
        "largest_gap_hours": int(gaps.max()) if len(gaps) else 0,
        "contiguous": bool(bad == 0 or int(gaps.max()) <= max_gap_hours),
    }


def get_hours(fetch_fn, bundle_path: Path | None = None,
              persist: bool = True, verbose: bool = True,
              now_ts: int | None = None) -> tuple[pd.DataFrame, dict]:
    """Bundle + live tail -> the hourly frame a forecast runs on.

    The tail length is derived from how far behind the bundle actually is,
    rather than being a fixed constant -- so a bundle that has not been
    rewritten for a week still gets fully caught up, and a fresh one costs a
    single request.
    """
    import time as _time

    bundle = load_bundle(bundle_path)
    last_bundle_hour = int(bundle["hour_ts"].iloc[-1])

    now = int(now_ts or _time.time())
    gap_hours = max(0, (now - last_bundle_hour) // HOUR)
    tail_hours = int(min(max(gap_hours + 6, 12), 24 * 30))   # slack, capped at 30d

    bars = fetch_fn(tail_hours=tail_hours)
    fresh = hours_from_bars(bars)
    hours = merge(bundle, fresh)

    info = {
        "bundle_last_hour": int(last_bundle_hour),
        "gap_hours": int(gap_hours),
        "tail_hours_requested": tail_hours,
        "fetched_bars": int(len(bars)),
        "fresh_complete_hours": int(len(fresh)),
        "new_hours": int((fresh["hour_ts"] > last_bundle_hour).sum()) if len(fresh) else 0,
        "source": str(bars["source"].iloc[0]) if "source" in bars.columns else "unknown",
        **check_continuity(hours),
    }

    if len(hours) < MIN_HISTORY_HOURS:
        raise RuntimeError(
            f"only {len(hours)}h of history, need >= {MIN_HISTORY_HOURS}h "
            f"(365d) or long-lookback features silently fall back to their "
            f"training means"
        )
    if not info["contiguous"]:
        raise RuntimeError(
            f"history has {info['gaps']} gaps (largest {info['largest_gap_hours']}h); "
            f"trailing-window features count rows, so a gap corrupts them"
        )

    # Rewrite the committed bundle only when it has drifted far enough to be
    # worth a new ~716 KB blob (see PERSIST_AFTER_HOURS).
    info["bundle_rewritten"] = bool(
        persist and info["new_hours"] >= PERSIST_AFTER_HOURS
    )
    if info["bundle_rewritten"]:
        save_bundle(hours, bundle_path)
    if verbose:
        print(f"[history] {info}")
    return hours, info
