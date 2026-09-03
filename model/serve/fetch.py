"""
serve/fetch.py
=====================================================================
Live market data: the recent TAIL only.

The long history lives in a committed hourly bundle (see `serve/history.py`),
so this module only has to fetch enough recent 5-minute bars to bring that
bundle up to now. At a 30-minute cron cadence that is a single request.

Two bugs from the first live run are fixed here, both found only in production
because this session's egress proxy blocks every exchange API.

1. PAGINATION NEVER ADVANCED.
   The old loop passed BOTH `start` and `end` to Bitstamp's OHLC endpoint.
   Given both, Bitstamp anchors the window to `end` and returns the most
   recent `limit` candles -- so every iteration returned the same final page,
   the cursor jumped past `end`, and the loop exited after one call with
   exactly 1000 bars (83.2 h). We now paginate forward with `start` ONLY, and
   assert forward progress each iteration instead of trusting it.

2. THE BINANCE FALLBACK IS UNUSABLE FROM CI.
   It returned `HTTP 451 Unavailable For Legal Reasons`: GitHub's hosted
   runners sit in Azure US regions and Binance geo-blocks US IPs. It has been
   replaced by Coinbase Exchange (BTC-USD, US-accessible, and a real USD pair
   like Bitstamp rather than a USDT perp).

Venue consistency still matters more than it looks: the model predicts BARRIER
TOUCHES, and different venues wick to different extremes, so a fallback is
flagged in the output rather than silently substituted.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

import numpy as np
import pandas as pd

STEP = 300                       # 5-minute bars
MAX_PER_CALL = 1000              # Bitstamp's limit
DEFAULT_TAIL_HOURS = 72          # comfortably covers a missed cron or two

BITSTAMP = "https://www.bitstamp.net/api/v2/ohlc/{pair}/"
COINBASE = "https://api.exchange.coinbase.com/products/{product}/candles"

# Venue symbols per asset. BTC is the production path and its defaults are
# unchanged; the rest exist so the model can be tested on instruments it was
# never trained on. Same quote currency (USD) throughout, because a USDT pair
# would fold stablecoin depeg risk into the excursion distribution.
SYMBOLS = {
    "btc": ("btcusd", "BTC-USD"),
    "eth": ("ethusd", "ETH-USD"),
    "sol": ("solusd", "SOL-USD"),
    "xrp": ("xrpusd", "XRP-USD"),
    "ltc": ("ltcusd", "LTC-USD"),
    "ada": ("adausd", "ADA-USD"),
    "link": ("linkusd", "LINK-USD"),
    "doge": ("dogeusd", "DOGE-USD"),
}
UA = {"User-Agent": "noctua/1.1 (+https://github.com/deeploopinnovations/btc-dashboard)"}


def _get(url: str, timeout: int = 25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _finish(rows: list[dict], source: str) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = df[c].astype(np.float64)
    df["timestamp"] = df["timestamp"].astype(np.int64)
    df = df.drop_duplicates("timestamp").sort_values("timestamp", ignore_index=True)
    df["source"] = source
    df["bad_print"] = False
    return df[["timestamp", "open", "high", "low", "close", "volume", "source", "bad_print"]]


# --------------------------------------------------------------------------
def fetch_bitstamp(tail_hours: int = DEFAULT_TAIL_HOURS,
                   symbol: str = "btc") -> pd.DataFrame:
    """Recent 5-minute bars for `symbol`, oldest-first.

    Paginates forward using `start` alone. Passing `end` as well makes the API
    anchor to the end of the window and re-serve the same final page, which is
    what broke the previous implementation.
    """
    pair = SYMBOLS[symbol][0]
    base = BITSTAMP.format(pair=pair)
    now = int(time.time())
    start = now - tail_hours * 3600
    need_calls = max(1, int(np.ceil(tail_hours * 3600 / (STEP * MAX_PER_CALL))))

    rows: list[dict] = []
    cursor = start
    for _ in range(need_calls + 2):          # +2 slack for partial pages
        data = _get(f"{base}?step={STEP}&limit={MAX_PER_CALL}&start={cursor}")
        page = data.get("data", {}).get("ohlc", [])
        if not page:
            break
        rows.extend(page)
        newest = int(page[-1]["timestamp"])
        if newest <= cursor:                 # no forward progress -> stop, do not spin
            break
        cursor = newest + STEP
        if cursor >= now:
            break
        time.sleep(0.25)                     # polite to a free public endpoint

    if not rows:
        raise RuntimeError(f"bitstamp returned no candles for {pair}")
    return _finish(rows, f"bitstamp:{pair}")


def fetch_coinbase(tail_hours: int = DEFAULT_TAIL_HOURS,
                   symbol: str = "btc") -> pd.DataFrame:
    """Fallback: Coinbase Exchange, max 300 candles per request.

    Same asset and quote currency as the training venue, and reachable from US
    runners -- unlike Binance, which returns 451 there.
    """
    product = SYMBOLS[symbol][1]
    now = int(time.time())
    start = now - tail_hours * 3600
    rows: list[dict] = []
    cursor = start
    while cursor < now:
        end = min(cursor + 300 * STEP, now)
        url = (f"{COINBASE.format(product=product)}?granularity={STEP}"
               f"&start={pd.Timestamp(cursor, unit='s', tz='UTC').isoformat()}"
               f"&end={pd.Timestamp(end, unit='s', tz='UTC').isoformat()}")
        page = _get(url)                     # [[time, low, high, open, close, volume], ...]
        if not page:
            break
        rows.extend({
            "timestamp": int(c[0]), "low": c[1], "high": c[2],
            "open": c[3], "close": c[4], "volume": c[5],
        } for c in page)
        cursor = end
        time.sleep(0.25)

    if not rows:
        raise RuntimeError(f"coinbase returned no candles for {product}")
    return _finish(rows, f"coinbase:{product} (FALLBACK - venue mismatch)")


# --------------------------------------------------------------------------
def validate_bars(df: pd.DataFrame, tail_hours: int) -> pd.DataFrame:
    """Reject a feed too broken to extend the history with."""
    if len(df) < 12:
        raise RuntimeError(f"only {len(df)} bars returned")
    if (df[["open", "high", "low", "close"]] <= 0).any().any():
        raise RuntimeError("non-positive prices in feed")

    span_h = (df.timestamp.iloc[-1] - df.timestamp.iloc[0]) / 3600.0
    if span_h < min(6.0, tail_hours * 0.25):
        raise RuntimeError(f"feed spans only {span_h:.1f}h")

    # A gap inside the fetched tail means some hours will be incomplete and
    # dropped by history.hours_from_bars; a lot of them means a bad feed.
    gaps = np.diff(df.timestamp.to_numpy(np.int64))
    if (gaps > 4 * STEP).sum() > max(2, 0.02 * len(df)):
        raise RuntimeError("feed has too many gaps to build realized measures")

    stale_h = (time.time() - df.timestamp.iloc[-1]) / 3600.0
    if stale_h > 3.0:
        raise RuntimeError(f"feed's newest bar is {stale_h:.1f}h old")
    return df


def fetch_bars(tail_hours: int = DEFAULT_TAIL_HOURS,
               symbol: str = "btc") -> pd.DataFrame:
    """Primary venue, then fallback. Every failure is reported, not swallowed.

    `symbol` defaults to btc, so the production call site is unchanged.
    """
    errors = []
    for fn in (fetch_bitstamp, fetch_coinbase):
        try:
            return validate_bars(fn(tail_hours=tail_hours, symbol=symbol), tail_hours)
        except Exception as e:  # noqa: BLE001 - surface every source that failed
            detail = ""
            if isinstance(e, urllib.error.HTTPError):
                detail = f" (HTTP {e.code})"
            errors.append(f"{fn.__name__}: {type(e).__name__}: {e}{detail}")
    raise RuntimeError("all data sources failed -> " + " | ".join(errors))
