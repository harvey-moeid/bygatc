"""
serve/bootstrap_bundle.py
=====================================================================
Build `data/noctua_history.parquet` from scratch when it does not exist.

Dipanggil oleh GitHub Actions CI saat bundle belum pernah di-commit.
Mengambil 400+ hari 5-minute bars dari Bitstamp (primary) atau Coinbase
(fallback), lalu mem-build hourly bundle menggunakan build_hourly yang SAMA
dengan yang dipakai training -- sehingga tidak ada train/serve skew.

Setelah bootstrap, bundle di-commit kembali ke repo agar run berikutnya
hanya perlu fetch tail (satu request), sesuai desain awal history.py.

Usage (CI):
    python model/serve/bootstrap_bundle.py
    # lalu commit data/noctua_history.parquet via git

Usage (manual):
    python model/serve/bootstrap_bundle.py --days 400 --out data/noctua_history.parquet
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua.episodes import build_hourly         # noqa: E402
from serve.history import (
    HOURLY_COLS, check_continuity, default_bundle_path, save_bundle,  # noqa: E402
)

STEP = 300           # 5-minute bars
MAX_PER_CALL = 1000  # Bitstamp hard limit
UA = {"User-Agent": "noctua-bootstrap/1.0"}


def _get(url: str, timeout: int = 30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _fetch_bitstamp_window(start: int, end: int) -> list[dict]:
    """Fetch 5-minute Bitstamp bars for [start, end), paginating forward."""
    base = "https://www.bitstamp.net/api/v2/ohlc/btcusd/"
    rows: list[dict] = []
    cursor = start
    while cursor < end:
        url = f"{base}?step={STEP}&limit={MAX_PER_CALL}&start={cursor}"
        try:
            data = _get(url)
        except urllib.error.HTTPError as e:
            print(f"[bootstrap] bitstamp HTTP {e.code} at cursor={cursor}, retrying in 5s")
            time.sleep(5)
            continue
        page = data.get("data", {}).get("ohlc", [])
        if not page:
            break
        rows.extend(page)
        newest = int(page[-1]["timestamp"])
        if newest <= cursor:
            break
        cursor = newest + STEP
        time.sleep(0.3)  # polite rate limiting
    return rows


def _fetch_coinbase_window(start: int, end: int) -> list[dict]:
    """Fallback: Coinbase Exchange, 300 candles per request."""
    rows: list[dict] = []
    cursor = start
    while cursor < end:
        chunk_end = min(cursor + 300 * STEP, end)
        s_iso = pd.Timestamp(cursor, unit="s", tz="UTC").isoformat()
        e_iso = pd.Timestamp(chunk_end, unit="s", tz="UTC").isoformat()
        url = (f"https://api.exchange.coinbase.com/products/BTC-USD/candles"
               f"?granularity={STEP}&start={s_iso}&end={e_iso}")
        try:
            page = _get(url)
        except urllib.error.HTTPError as e:
            print(f"[bootstrap] coinbase HTTP {e.code} at cursor={cursor}, retrying in 5s")
            time.sleep(5)
            continue
        if not page:
            break
        rows.extend({
            "timestamp": int(c[0]), "low": c[1], "high": c[2],
            "open": c[3], "close": c[4], "volume": c[5],
        } for c in page)
        cursor = chunk_end
        time.sleep(0.3)
    return rows


def fetch_history_bars(days: int = 405) -> pd.DataFrame:
    """Fetch ~`days` days of 5-minute bars. Tries Bitstamp, falls back to Coinbase."""
    now = int(time.time())
    start = now - days * 86400

    print(f"[bootstrap] fetching ~{days} days of 5-min bars from Bitstamp...")
    try:
        rows = _fetch_bitstamp_window(start, now)
        source = "bitstamp:btcusd"
        if len(rows) < 100:
            raise RuntimeError(f"too few bars from bitstamp: {len(rows)}")
        print(f"[bootstrap] bitstamp: {len(rows)} bars fetched")
    except Exception as e:
        print(f"[bootstrap] bitstamp failed ({e}), trying Coinbase...")
        rows = _fetch_coinbase_window(start, now)
        source = "coinbase:BTC-USD (FALLBACK)"
        if len(rows) < 100:
            raise RuntimeError(f"too few bars from coinbase: {len(rows)}")
        print(f"[bootstrap] coinbase: {len(rows)} bars fetched")

    df = pd.DataFrame(rows)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = df[col].astype(np.float64)
    df["timestamp"] = df["timestamp"].astype(np.int64)
    df = df.drop_duplicates("timestamp").sort_values("timestamp", ignore_index=True)
    df["bad_print"] = False
    df["source"] = source
    return df


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Bootstrap history bundle from public API")
    p.add_argument("--days", type=int, default=405,
                   help="Days of history to fetch (default 405 = 400d bundle + 5d slack)")
    p.add_argument("--out", type=Path, default=None,
                   help="Output path (default: data/noctua_history.parquet)")
    a = p.parse_args(argv)

    out_path = Path(a.out) if a.out else default_bundle_path()

    if out_path.exists():
        print(f"[bootstrap] bundle already exists at {out_path}, skipping.")
        return 0

    bars = fetch_history_bars(days=a.days)
    print(f"[bootstrap] aggregating {len(bars)} bars to hourly...")
    hours = build_hourly(bars)

    # Pastikan kolom yang dibutuhkan ada
    missing = set(HOURLY_COLS) - set(hours.columns)
    if missing:
        raise RuntimeError(f"build_hourly missing columns: {missing}")

    saved_path = save_bundle(hours, out_path)
    written = pd.read_parquet(saved_path)
    info = {
        "path": str(saved_path),
        "size_kb": round(saved_path.stat().st_size / 1024, 1),
        "rows": int(len(written)),
        "start_utc": str(pd.to_datetime(int(written.hour_ts.iloc[0]), unit="s", utc=True)),
        "end_utc": str(pd.to_datetime(int(written.hour_ts.iloc[-1]), unit="s", utc=True)),
        "source": str(bars["source"].iloc[0]),
        **check_continuity(written),
    }
    print(json.dumps(info, indent=2))

    if info["rows"] < 365 * 24:
        raise RuntimeError(
            f"bundle only has {info['rows']}h, need >= {365*24}h. "
            f"Try increasing --days."
        )
    if not info["contiguous"]:
        print(f"[bootstrap] WARNING: {info['gaps']} gap(s) detected "
              f"(largest {info['largest_gap_hours']}h). "
              f"Bundle saved anyway; next predict run will validate.")

    print("[bootstrap] done. Commit data/noctua_history.parquet to repo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
