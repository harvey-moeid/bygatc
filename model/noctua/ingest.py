"""
noctua/ingest.py
=====================================================================
Stage 1 of the NOCTUA pipeline: raw 1-minute OHLCV -> validated parquet.

Source: ff137/bitstamp-btcusd-minute-data (MIT), BTC/USD 1-minute bars from
Bitstamp, 2012-01-01 to present, mirrored on GitHub and updated daily.

Two files are concatenated:
    data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz   (bulk)
    data/updates/btcusd_bitstamp_1min_latest.csv            (daily appends)

`timestamp` is the UNIX epoch second at the START of each minute bar; the bar
covers [t, t+60).

What this stage guarantees downstream:
  * strictly increasing, gap-free 1-minute grid (gaps forward-filled and FLAGGED)
  * OHLC internal consistency (low <= min(o,c) <= max(o,c) <= high)
  * no nulls, no non-positive prices
  * isolated bad prints ("wick artifacts") identified, since barrier-touch
    labels are read directly off high/low and a single bogus wick would teach
    the model a touch that never economically happened.

Run:
    python -m noctua.ingest --repo <path-to-cloned-bitstamp-repo> --out <dir>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

MINUTE = 60


def _read_raw(repo: Path) -> pd.DataFrame:
    hist = repo / "data" / "historical" / "btcusd_bitstamp_1min_2012-2025.csv.gz"
    latest = repo / "data" / "updates" / "btcusd_bitstamp_1min_latest.csv"
    if not hist.exists():
        raise FileNotFoundError(f"bulk history not found at {hist}")

    cols = ["timestamp", "open", "high", "low", "close", "volume"]
    frames = [pd.read_csv(hist, usecols=cols)]
    if latest.exists():
        frames.append(pd.read_csv(latest, usecols=cols))
    else:
        print("[ingest] WARNING: no daily-update file; history may end early")

    df = pd.concat(frames, ignore_index=True)
    df = df.drop_duplicates(subset="timestamp", keep="last")
    df = df.sort_values("timestamp", ignore_index=True)
    return df


def _to_regular_grid(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Reindex onto a strict 1-minute grid.

    Missing minutes are forward-filled as zero-volume, zero-range bars (the
    standard convention for "no trades happened"), and marked in `filled` so
    that realized-variance estimators can exclude them instead of silently
    counting a fabricated zero return.
    """
    t0, t1 = int(df.timestamp.iloc[0]), int(df.timestamp.iloc[-1])
    full = np.arange(t0, t1 + MINUTE, MINUTE, dtype=np.int64)
    n_missing = len(full) - len(df)

    df = df.set_index("timestamp").reindex(full)
    df.index.name = "timestamp"
    filled = df["close"].isna().to_numpy()

    # carry the last known close into every OHLC slot of a missing minute
    df["close"] = df["close"].ffill()
    for c in ("open", "high", "low"):
        df[c] = df[c].where(~filled, df["close"])
    df["volume"] = df["volume"].fillna(0.0)
    df["filled"] = filled

    return df.reset_index(), {"missing_minutes_filled": int(n_missing)}


def _repair_ohlc(df: pd.DataFrame) -> dict:
    """Enforce low <= min(open, close) and high >= max(open, close)."""
    lo_bad = df["low"] > df[["open", "close"]].min(axis=1)
    hi_bad = df["high"] < df[["open", "close"]].max(axis=1)
    df.loc[lo_bad, "low"] = df.loc[lo_bad, ["open", "close"]].min(axis=1)
    df.loc[hi_bad, "high"] = df.loc[hi_bad, ["open", "close"]].max(axis=1)
    return {"ohlc_low_repaired": int(lo_bad.sum()), "ohlc_high_repaired": int(hi_bad.sum())}


def _flag_bad_prints(
    df: pd.DataFrame,
    z: float = 12.0,
    min_abs_excursion: float = 0.004,
    scale_floor: float = 5e-5,
) -> dict:
    """Flag isolated wick artifacts.

    A bad print here is a bar whose high/low excursion away from the local
    close level is (a) large in absolute terms, (b) extreme relative to recent
    volatility, and (c) leaves no trace in the neighbouring closes -- i.e. the
    price "went" there and instantly came back with the surrounding market
    undisturbed. On a thin venue these are usually a single erroneous trade or
    a momentary book gap, not a level the market genuinely traded through.

    Why this matters specifically: barrier-touch labels are read straight off
    high/low. Deribit-settled options settle on a MULTI-VENUE index, so a
    Bitstamp-only wick is a level that never economically broke. Counting it
    would teach the model a touch that a real seller would not have suffered.

    All three conditions are required, and two guards keep the detector honest
    in the illiquid early era:
      * `min_abs_excursion` -- a 1-minute excursion below ~0.4% is never a bad
        print in any economically meaningful sense, however unusual it looks.
      * `scale_floor` -- in 2013-2016 up to 39% of minutes have zero volume, so
        the rolling MAD of returns collapses toward zero and *every* wick looks
        like a 12-sigma event. Flooring the scale stops that degeneracy.

    We flag rather than delete: `bad_print` is carried downstream so labels can
    be built with and without these bars and the sensitivity reported, rather
    than hidden behind a filter.
    """
    close = df["close"].to_numpy(dtype=np.float64)
    logc = np.log(close)

    # robust local scale: MAD of 1-minute log returns over a trailing hour
    ret = np.diff(logc, prepend=logc[0])
    scale = (
        pd.Series(np.abs(ret)).rolling(60, min_periods=20).median().to_numpy() * 1.4826
    )
    scale = np.maximum(np.nan_to_num(scale, nan=scale_floor), scale_floor)

    up = np.log(df["high"].to_numpy(dtype=np.float64)) - logc
    dn = logc - np.log(df["low"].to_numpy(dtype=np.float64))
    excursion = np.maximum(up, dn)

    # neighbouring closes must be undisturbed for it to count as "isolated"
    prev_step = np.abs(np.diff(logc, prepend=logc[0]))
    next_step = np.abs(np.diff(logc, append=logc[-1]))
    isolated = np.maximum(prev_step, next_step) < 0.25 * excursion

    bad = (excursion > np.maximum(z * scale, min_abs_excursion)) & isolated
    df["bad_print"] = bad
    return {
        "bad_prints_flagged": int(bad.sum()),
        "bad_print_pct": round(100.0 * float(bad.mean()), 4),
    }


def ingest(repo: Path, out_dir: Path) -> pd.DataFrame:
    out_dir.mkdir(parents=True, exist_ok=True)
    report: dict = {}

    print("[ingest] reading raw CSVs ...")
    df = _read_raw(repo)
    report["raw_rows"] = int(len(df))
    report["raw_start_utc"] = str(pd.to_datetime(df.timestamp.iloc[0], unit="s", utc=True))
    report["raw_end_utc"] = str(pd.to_datetime(df.timestamp.iloc[-1], unit="s", utc=True))

    bad_price = (df[["open", "high", "low", "close"]] <= 0).any(axis=1) | df[
        ["open", "high", "low", "close"]
    ].isna().any(axis=1)
    if bad_price.any():
        report["dropped_nonpositive_or_null"] = int(bad_price.sum())
        df = df.loc[~bad_price].reset_index(drop=True)

    print("[ingest] regularising to a strict 1-minute grid ...")
    df, r = _to_regular_grid(df)
    report.update(r)

    report.update(_repair_ohlc(df))
    print("[ingest] flagging isolated bad prints ...")
    report.update(_flag_bad_prints(df))

    df["dt"] = pd.to_datetime(df["timestamp"], unit="s", utc=True)
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = df[c].astype(np.float64)

    report["final_rows"] = int(len(df))
    report["final_start_utc"] = str(df.dt.iloc[0])
    report["final_end_utc"] = str(df.dt.iloc[-1])
    report["pct_minutes_filled"] = round(100.0 * df.filled.mean(), 4)
    report["pct_zero_volume"] = round(100.0 * float((df.volume == 0).mean()), 4)

    path = out_dir / "btcusd_1min.parquet"
    df.to_parquet(path, index=False, compression="zstd")
    report["parquet_mb"] = round(path.stat().st_size / 1e6, 1)

    (out_dir / "ingest_report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"[ingest] wrote {path}")
    return df


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Ingest Bitstamp 1-minute BTC/USD data")
    p.add_argument("--repo", required=True, type=Path, help="clone of ff137/bitstamp-btcusd-minute-data")
    p.add_argument("--out", required=True, type=Path, help="output directory")
    a = p.parse_args(argv)
    ingest(a.repo, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
