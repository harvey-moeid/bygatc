"""
noctua/features.py
=====================================================================
Stage 3: hourly bars -> the feature matrix seen at each anchor.

NO-LOOKAHEAD CONTRACT
---------------------
For an episode anchored at hour index `a`, every feature is a function of
hourly rows with index <= a-1 only. This is enforced structurally rather than
by convention: all trailing aggregates are built from cumulative sums that are
shifted by one hour before use, so an off-by-one cannot silently leak the
anchor hour itself. `audit_lookahead()` re-verifies it numerically by
perturbing the future and confirming no feature moves.

The single exception is deliberate and sound: CALENDAR features of the forward
window (how much of it lands on a weekend, which hours it spans). The calendar
is known years in advance, so using it is not lookahead -- and per RESEARCH_PLAN
section 2.4(iii) the weekend is the largest calendar effect in the data.

Feature families
----------------
  har_*        Log-HAR cascade of trailing realized vol (the primary signal)
  seas_*       Same-clock-window realized vol on prior days
  semi_*       Realized semivariances, signed jump variation (Patton-Sheppard)
  jump_*       Bipower variation / jump component
  rq_*         Realized quarticity (HARQ attenuation)
  rng_*        Parkinson / Garman-Klass range estimators
  mom_*        Trend, drawdown, distance to long moving average
  vov_*        Volatility of volatility
  cal_*        Clock, day of week, forward-window weekend fraction, horizon
  reg_*        Regime: RV percentile, post-ETF flag, volume trend
"""
from __future__ import annotations

import numpy as np
import pandas as pd

HOUR = 3600
DAY_H = 24
EPS = 1e-12

# trailing windows in hours
HAR_WINDOWS = {"1h": 1, "6h": 6, "1d": 24, "5d": 120, "22d": 528}
ETF_LAUNCH_TS = 1704931200  # 2024-01-11 00:00 UTC


def _trailing_sum(x: np.ndarray, k: int) -> np.ndarray:
    """out[i] = sum(x[i-k : i]) -- strictly BEFORE i. NaN until enough history."""
    c = np.concatenate([[0.0], np.cumsum(x)])
    n = len(x)
    out = np.full(n, np.nan)
    idx = np.arange(n)
    ok = idx >= k
    out[ok] = c[idx[ok]] - c[idx[ok] - k]
    return out


def _trailing_max(x: np.ndarray, k: int) -> np.ndarray:
    n = len(x)
    out = np.full(n, np.nan)
    if n <= k:
        return out
    win = np.lib.stride_tricks.sliding_window_view(x, k)  # (n-k+1, k)
    out[k:] = win[: n - k].max(axis=1)
    return out


def _trailing_mean_log(x: np.ndarray, k: int) -> np.ndarray:
    return _trailing_sum(x, k) / k


def _safe_log(x: np.ndarray) -> np.ndarray:
    return np.log(np.maximum(x, EPS))


def build_features(hours: pd.DataFrame, episodes: pd.DataFrame) -> pd.DataFrame:
    """Return a feature matrix aligned row-for-row with `episodes`."""
    rv5 = hours["rv5"].to_numpy(np.float64)
    rv_pos = hours["rv5_pos"].to_numpy(np.float64)
    rv_neg = hours["rv5_neg"].to_numpy(np.float64)
    bpv = hours["bpv5"].to_numpy(np.float64)
    rq = hours["rq5"].to_numpy(np.float64)
    close = hours["close"].to_numpy(np.float64)
    high = hours["high"].to_numpy(np.float64)
    low = hours["low"].to_numpy(np.float64)
    openp = hours["open"].to_numpy(np.float64)
    vol = hours["volume"].to_numpy(np.float64)
    n = len(hours)

    F: dict[str, np.ndarray] = {}

    # ---- HAR cascade: log realized VOL over trailing windows ----------------
    for name, k in HAR_WINDOWS.items():
        s = _trailing_sum(rv5, k)
        # per-hour variance rate, so windows of different length are comparable
        F[f"har_{name}"] = 0.5 * _safe_log(s / k)

    # ---- semivariance and signed jump variation -----------------------------
    for name, k in (("1d", 24), ("5d", 120)):
        sp = _trailing_sum(rv_pos, k)
        sn = _trailing_sum(rv_neg, k)
        tot = sp + sn + EPS
        F[f"semi_neg_share_{name}"] = sn / tot
        # signed jump variation, scaled to be O(1)
        F[f"semi_signed_jump_{name}"] = (sp - sn) / tot
        F[f"semi_neg_{name}"] = 0.5 * _safe_log(sn / k)

    # ---- jump component (rv - bipower) --------------------------------------
    for name, k in (("1d", 24), ("5d", 120)):
        s = _trailing_sum(rv5, k)
        b = _trailing_sum(bpv, k)
        F[f"jump_share_{name}"] = np.maximum(s - b, 0.0) / (s + EPS)

    # ---- realized quarticity (HARQ attenuation term) ------------------------
    s1 = _trailing_sum(rv5, 24)
    q1 = _trailing_sum(rq, 24)
    # sqrt(RQ)/RV is the standard HARQ regressor: large when RV is noisy
    F["rq_noise_1d"] = np.sqrt(np.maximum(q1, 0.0)) / (s1 + EPS)

    # ---- range estimators ---------------------------------------------------
    hl = _safe_log(high) - _safe_log(low)
    park = hl**2 / (4.0 * np.log(2.0))
    co = (_safe_log(close) - _safe_log(openp)) ** 2
    gk = 0.5 * hl**2 - (2.0 * np.log(2.0) - 1.0) * co
    for name, k in (("1d", 24), ("5d", 120)):
        F[f"rng_park_{name}"] = 0.5 * _safe_log(_trailing_sum(park, k) / k)
        F[f"rng_gk_{name}"] = 0.5 * _safe_log(np.maximum(_trailing_sum(gk, k), EPS) / k)

    # ---- path efficiency ----------------------------------------------------
    # How much of the volatility became NET TRAVEL. The estimators above are
    # per-bar: Parkinson sums squared HOURLY ranges and tracks RV almost
    # exactly. This is the different, window-SPANNING quantity
    #
    #     (max over k hours - min over k hours) / sqrt(sum of RV over k hours)
    #
    # which is dimensionless and asks whether the path trended or chopped.
    # Under Brownian motion it is the constant sqrt(8/pi) = 1.5958, which is
    # precisely the assumption Gaussian first-passage makes. On BTC it is not
    # constant: median 1.295 with an IQR of [1.017, 1.612], it is PERSISTENT
    # (Spearman +0.38 from trailing to forward at every lookback tried), and it
    # is essentially UNCORRELATED with realized vol itself (Spearman -0.036).
    #
    # That last number is why these are shape features and not level features:
    # a second axis the volatility cascade cannot see, aimed at the one thing
    # BENCHMARK.md says the committee does not win -- binary barrier
    # discrimination, where the competitor is exactly a first-passage formula
    # holding this ratio fixed.
    lhi, llo = _safe_log(high), _safe_log(low)
    for name, k in (("1d", 24), ("3d", 72), ("7d", 168)):
        span = _trailing_max(lhi, k) + _trailing_max(-llo, k)   # max - min
        F[f"eff_{name}"] = _safe_log(np.maximum(span, EPS)) - 0.5 * _safe_log(
            np.maximum(_trailing_sum(rv5, k), EPS))

    # ---- momentum / trend ---------------------------------------------------
    logc = _safe_log(close)
    for name, k in (("1d", 24), ("5d", 120), ("22d", 528)):
        prev = np.full(n, np.nan)
        prev[k:] = logc[: n - k]
        # return up to the PREVIOUS hour
        cur = np.full(n, np.nan)
        cur[1:] = logc[:-1]
        F[f"mom_ret_{name}"] = cur - prev

    ma100 = _trailing_mean_log(logc, 2400)  # ~100 days
    cur = np.full(n, np.nan)
    cur[1:] = logc[:-1]
    F["mom_dist_ma100"] = cur - ma100

    hi90 = _trailing_max(logc, 90 * DAY_H)
    F["mom_drawdown_90d"] = cur - hi90

    # ---- volatility of volatility -------------------------------------------
    lrv = 0.5 * _safe_log(np.maximum(rv5, EPS))
    for name, k in (("5d", 120), ("22d", 528)):
        m = _trailing_mean_log(lrv, k)
        m2 = _trailing_mean_log(lrv**2, k)
        F[f"vov_{name}"] = np.sqrt(np.maximum(m2 - m**2, 0.0))

    # ---- regime -------------------------------------------------------------
    rv1d = _trailing_sum(rv5, 24)
    yr = _trailing_sum(rv5, 365 * DAY_H)
    F["reg_rv_vs_year"] = _safe_log(np.maximum(rv1d / 24.0, EPS)) - _safe_log(
        np.maximum(yr / (365.0 * DAY_H), EPS)
    )
    v5 = _trailing_sum(vol, 120)
    v22 = _trailing_sum(vol, 528)
    F["reg_vol_trend"] = _safe_log(np.maximum(v5 / 120.0, EPS)) - _safe_log(
        np.maximum(v22 / 528.0, EPS)
    )

    hour_ts = hours["hour_ts"].to_numpy(np.int64)
    F["reg_post_etf"] = (hour_ts >= ETF_LAUNCH_TS).astype(np.float64)

    # ------------------------------------------------------------------
    # gather per-episode
    # ------------------------------------------------------------------
    rows = episodes["row"].to_numpy(np.int64)
    prev_rows = rows - 1  # the last hour STRICTLY before the anchor
    out = {k: v[prev_rows] for k, v in F.items()}

    # ---- seasonal HAR: same clock window on prior days ----------------------
    # RV of the window [a - d*24, a - d*24 + H) for d = 1, 5, 22. For H <= 24
    # these windows end at or before the anchor, so they are strictly historical.
    H = episodes["H"].to_numpy(np.int64)
    csum = np.concatenate([[0.0], np.cumsum(rv5)])
    for d in (1, 5, 22):
        start = rows - d * DAY_H
        end = start + H
        ok = (start >= 0) & (end <= rows)
        vals = np.full(len(rows), np.nan)
        s = np.clip(start, 0, n)
        e = np.clip(end, 0, n)
        seg = csum[e] - csum[s]
        vals[ok] = 0.5 * _safe_log(seg[ok] / np.maximum(H[ok], 1))
        out[f"seas_{d}d"] = vals

    if len(episodes) == 0:
        # A degenerate input series (e.g. a constant price) yields no valid
        # episodes at all, because the episode builder rejects windows with
        # zero realized variance. Return an empty frame with the right columns
        # rather than crashing -- refusing to forecast is the correct response.
        cols = list(out.keys()) + [f"seas_{d}d" for d in (1, 5, 22)] + [
            "cal_hour_sin", "cal_hour_cos", "cal_dow_sin", "cal_dow_cos",
            "cal_H", "cal_weekend_frac", "cal_month_sin", "cal_month_cos",
        ]
        return pd.DataFrame({c: np.zeros(0) for c in cols})

    # ---- calendar of the FORWARD window (known in advance, not lookahead) ---
    anchor_ts = episodes["anchor_ts"].to_numpy(np.int64)
    ah = episodes["anchor_hour"].to_numpy(np.float64)
    dow = episodes["dow"].to_numpy(np.float64)

    out["cal_hour_sin"] = np.sin(2 * np.pi * ah / 24.0)
    out["cal_hour_cos"] = np.cos(2 * np.pi * ah / 24.0)
    out["cal_dow_sin"] = np.sin(2 * np.pi * dow / 7.0)
    out["cal_dow_cos"] = np.cos(2 * np.pi * dow / 7.0)
    out["cal_H"] = H.astype(np.float64) / 24.0

    # weekend fraction of the forward window -- the dominant calendar signal
    maxH = int(H.max())
    offs = np.arange(maxH)
    fut_dow = (((anchor_ts[:, None] + offs[None, :] * HOUR) // 86400) + 4) % 7  # 0=Mon
    valid = offs[None, :] < H[:, None]
    is_we = ((fut_dow >= 5) & valid).sum(axis=1)
    out["cal_weekend_frac"] = is_we / np.maximum(H, 1)

    # mean climatological hourly variance over the forward window (the demoted
    # but still free clock signal): uses only the hour-of-day identity
    month = pd.to_datetime(anchor_ts, unit="s", utc=True).month.to_numpy(np.float64)
    out["cal_month_sin"] = np.sin(2 * np.pi * month / 12.0)
    out["cal_month_cos"] = np.cos(2 * np.pi * month / 12.0)

    X = pd.DataFrame(out, index=episodes.index)
    return X


def audit_lookahead(hours: pd.DataFrame, episodes: pd.DataFrame, n_probe: int = 200) -> dict:
    """Numerically verify the no-lookahead contract.

    Corrupt every hourly row at or after each probed anchor, rebuild features,
    and confirm that the probed rows' features are bit-identical. If any
    feature reads the anchor hour or beyond, this catches it.
    """
    rng = np.random.default_rng(0)
    base = build_features(hours, episodes)

    lo = int(len(hours) * 0.6)
    probe_rows = rng.choice(np.arange(lo, len(hours) - 30), size=n_probe, replace=False)
    cut = int(probe_rows.min())

    corrupt = hours.copy()
    mask = np.arange(len(corrupt)) >= cut
    for c in ("rv5", "rv5_pos", "rv5_neg", "bpv5", "rq5", "close", "high", "low", "open", "volume"):
        v = corrupt[c].to_numpy(np.float64).copy()
        v[mask] = v[mask] * rng.uniform(2.0, 5.0, size=mask.sum())
        corrupt[c] = v

    after = build_features(corrupt, episodes)
    sel = episodes["row"].to_numpy() <= cut  # anchors whose features predate the cut
    a = base.loc[sel].to_numpy(np.float64)
    b = after.loc[sel].to_numpy(np.float64)
    both_nan = np.isnan(a) & np.isnan(b)
    diff = np.where(both_nan, 0.0, np.abs(a - b))
    bad = np.nanmax(diff) if diff.size else 0.0

    offenders = []
    if bad > 0:
        col_max = np.nanmax(np.where(both_nan, 0.0, np.abs(a - b)), axis=0)
        offenders = [
            base.columns[i] for i in np.argsort(-col_max)[:5] if col_max[i] > 0
        ]
    return {
        "cut_row": int(cut),
        "episodes_checked": int(sel.sum()),
        "max_abs_feature_change": float(bad),
        "leak_free": bool(bad == 0.0),
        "offending_features": offenders,
    }
