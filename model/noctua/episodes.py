"""
noctua/episodes.py
=====================================================================
Stage 2: validated 1-minute bars -> clock-anchored forecasting episodes.

An *episode* is one instance of the seller's decision:

    at anchor time  tau  (top of some UTC hour)
    holding for     H    hours
    observe         everything strictly before tau
    predict         the joint law of (R, RV, M+, M-) over [tau, tau+H)

The production configuration is tau = 17:00 UTC, H = 19 -> settlement at
12:00 UTC next day, i.e. 22:30 IST -> 17:30 IST, the Delta Exchange BTC daily
contract. Episodes are generated at EVERY anchor hour and several horizons so
the model can learn the clock as a conditioning variable rather than being
fitted separately per hour (see RESEARCH_PLAN.md section 3.4).

Exactness
---------
Windows are an integer number of hours and anchors sit on hour boundaries, so
all labels are computed on an HOURLY aggregate table without approximation:

    M+   = max of hourly highs   == max of the underlying 1-minute highs
    M-   = min of hourly lows    == min of the underlying 1-minute lows
    RV   = sqrt(sum of hourly realized variances)

The 5-minute return grid divides the hour exactly (12 buckets), so bucketing
realized variance by hour loses nothing.

No-lookahead contract
---------------------
    S_tau      = close of hour (a-1)          -- last price known AT tau
    labels     = hours [a, a+H)               -- strictly after tau
    features   = hours <= a-1                 -- strictly before tau

Run:
    python -m noctua.episodes --parquet <btcusd_1min.parquet> --out <dir>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HOUR = 3600
DEFAULT_HORIZONS = (6, 12, 19, 24)


# --------------------------------------------------------------------------
# hourly aggregation
# --------------------------------------------------------------------------
def build_hourly(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate 1-minute bars into an exact, gap-free hourly table.

    Carries two realized-variance columns per hour:
      rv5  -- sum of squared 5-minute log returns (the RV-literature standard;
              5 minutes trades off microstructure noise against accuracy)
      rv1  -- sum of squared 1-minute log returns (noisier, reported for
              sensitivity)
    and a `clean` variant of high/low with flagged bad prints neutralised.
    """
    ts = df["timestamp"].to_numpy(np.int64)
    close = df["close"].to_numpy(np.float64)
    high = df["high"].to_numpy(np.float64)
    low = df["low"].to_numpy(np.float64)
    openp = df["open"].to_numpy(np.float64)
    vol = df["volume"].to_numpy(np.float64)
    bad = df["bad_print"].to_numpy(bool)

    # bad prints: replace the wick with the bar's own open/close envelope, so
    # the bar still exists but no longer asserts a level that never traded
    hi_clean = np.where(bad, np.maximum(openp, close), high)
    lo_clean = np.where(bad, np.minimum(openp, close), low)

    hidx = ts // HOUR
    h0 = hidx[0]
    slot = (hidx - h0).astype(np.int64)
    n_hours = int(slot[-1]) + 1

    def _agg(values, op, init):
        out = np.full(n_hours, init, dtype=np.float64)
        op(out, slot, values)
        return out

    hour_high = _agg(high, np.maximum.at, -np.inf)
    hour_low = _agg(low, np.minimum.at, np.inf)
    hour_high_c = _agg(hi_clean, np.maximum.at, -np.inf)
    hour_low_c = _agg(lo_clean, np.minimum.at, np.inf)
    hour_vol = _agg(vol, np.add.at, 0.0)
    hour_bad = _agg(bad.astype(np.float64), np.add.at, 0.0)

    # first/last minute of each hour -> open/close
    first_idx = np.full(n_hours, -1, dtype=np.int64)
    last_idx = np.full(n_hours, -1, dtype=np.int64)
    first_idx[slot[::-1]] = np.arange(len(slot))[::-1]
    last_idx[slot] = np.arange(len(slot))
    hour_open = openp[first_idx]
    hour_close = close[last_idx]

    # ---- realized variance on a 5-minute grid -------------------------------
    logc = np.log(close)
    # index of the last minute in each 5-minute bucket
    b5 = ts // 300
    last5 = np.full(int(b5[-1] - b5[0]) + 1, -1, dtype=np.int64)
    last5[(b5 - b5[0])] = np.arange(len(b5))
    last5 = last5[last5 >= 0]
    r5 = np.diff(logc[last5])
    # the 5-min return ending at bucket k belongs to the hour of that bucket end
    r5_hour = (ts[last5[1:]] // HOUR) - h0
    rv5 = np.zeros(n_hours)
    np.add.at(rv5, r5_hour, r5**2)

    # ---- decomposed realized measures (Barndorff-Nielsen / Patton-Sheppard) --
    # Realized SEMIvariances: separating upside from downside variance is the
    # measurable form of the leverage effect, and downside semivariance carries
    # most of the predictive content for future volatility. For a PUT seller
    # this is the single most relevant decomposition available.
    rv5_pos = np.zeros(n_hours)
    rv5_neg = np.zeros(n_hours)
    np.add.at(rv5_pos, r5_hour, np.where(r5 > 0, r5**2, 0.0))
    np.add.at(rv5_neg, r5_hour, np.where(r5 < 0, r5**2, 0.0))

    # Bipower variation: jump-robust estimate of the CONTINUOUS variance.
    # rv5 - bpv5 isolates the jump component.
    bp = (np.pi / 2.0) * np.abs(r5[1:]) * np.abs(r5[:-1])
    bpv5 = np.zeros(n_hours)
    np.add.at(bpv5, r5_hour[1:], bp)

    # Realized quarticity: measures the MEASUREMENT ERROR in rv5 itself, which
    # is what HARQ uses to attenuate coefficients when RV is noisily estimated.
    rq5 = np.zeros(n_hours)
    np.add.at(rq5, r5_hour, r5**4)
    rq5 *= 12.0 / 3.0  # n/3 with n = 12 five-minute buckets per hour

    r1 = np.diff(logc, prepend=logc[0])
    rv1 = np.zeros(n_hours)
    np.add.at(rv1, slot, r1**2)

    hours = pd.DataFrame(
        {
            "hour_ts": (h0 + np.arange(n_hours)) * HOUR,
            "open": hour_open,
            "high": hour_high,
            "low": hour_low,
            "close": hour_close,
            "high_clean": hour_high_c,
            "low_clean": hour_low_c,
            "volume": hour_vol,
            "n_bad": hour_bad,
            "rv5": rv5,
            "rv5_pos": rv5_pos,
            "rv5_neg": rv5_neg,
            "bpv5": bpv5,
            "rq5": rq5,
            "rv1": rv1,
        }
    )
    hours["dt"] = pd.to_datetime(hours["hour_ts"], unit="s", utc=True)
    return hours


# --------------------------------------------------------------------------
# episode construction
# --------------------------------------------------------------------------
def _rolling_forward(a: np.ndarray, H: int, op: str) -> np.ndarray:
    """Forward-looking window aggregate: out[i] = op(a[i : i+H]).

    Implemented with a strided view; positions with fewer than H hours ahead
    are returned as NaN.
    """
    n = len(a)
    out = np.full(n, np.nan)
    if n < H:
        return out
    win = np.lib.stride_tricks.sliding_window_view(a, H)  # (n-H+1, H)
    if op == "max":
        v = win.max(axis=1)
    elif op == "min":
        v = win.min(axis=1)
    elif op == "sum":
        v = win.sum(axis=1)
    else:
        raise ValueError(op)
    out[: n - H + 1] = v
    return out


def build_episodes(hours: pd.DataFrame, horizons=DEFAULT_HORIZONS) -> pd.DataFrame:
    """Build one row per (anchor hour, horizon) with all forward labels."""
    n = len(hours)
    hour_ts = hours["hour_ts"].to_numpy(np.int64)
    close = hours["close"].to_numpy(np.float64)
    high = hours["high"].to_numpy(np.float64)
    low = hours["low"].to_numpy(np.float64)
    rv5 = hours["rv5"].to_numpy(np.float64)

    # Bundles harvested from an exchange's 5-MINUTE bars (data/assets/*.parquet)
    # cannot carry the 1-minute-derived columns that build_hourly produces from
    # the BTC tick file. Fall back rather than refuse, because nothing the model
    # trains on depends on them:
    #
    #   high_clean/low_clean  feed ONLY M_up_clean / M_dn_clean, which have no
    #                         references in train.py or any eval. Note that
    #                         M_up/M_dn -- the columns training actually uses --
    #                         are built from RAW high/low for BTC as well, so
    #                         the fallback introduces no asymmetry between
    #                         pooled assets.
    #   rv1                   feeds ONLY RV1, which is FORWARD-looking
    #                         (correlates 0.953 with the target) and is
    #                         deliberately avoided everywhere for that reason.
    #
    # If either becomes load-bearing later, this fallback must go and the
    # harvested bundles must be rebuilt from 1-minute data instead.
    def _opt(name: str, fallback: str) -> np.ndarray:
        col = name if name in hours.columns else fallback
        return hours[col].to_numpy(np.float64)

    high_c = _opt("high_clean", "high")
    low_c = _opt("low_clean", "low")
    rv1 = _opt("rv1", "rv5")

    # S_tau is the close of the PREVIOUS hour: the last price known at tau
    s_tau = np.full(n, np.nan)
    s_tau[1:] = close[:-1]

    frames = []
    for H in horizons:
        fwd_max = _rolling_forward(high, H, "max")
        fwd_min = _rolling_forward(low, H, "min")
        fwd_max_c = _rolling_forward(high_c, H, "max")
        fwd_min_c = _rolling_forward(low_c, H, "min")
        fwd_rv5 = _rolling_forward(rv5, H, "sum")
        fwd_rv1 = _rolling_forward(rv1, H, "sum")

        # terminal price = close of hour (a + H - 1)
        s_T = np.full(n, np.nan)
        s_T[: n - H + 1] = close[H - 1 :]

        ok = (
            np.isfinite(s_tau)
            & np.isfinite(s_T)
            & np.isfinite(fwd_max)
            & (s_tau > 0)
            & (fwd_rv5 > 0)  # dead hours with literally no trades (2012-2015)
        )
        idx = np.flatnonzero(ok)

        ls = np.log(s_tau[idx])
        # The running extremum is taken over the path INCLUDING its starting
        # point S_tau. Without the max(0, .) / min(0, .) the discrete-bar gap
        # between close(tau-60) and the first bar at tau can make the "running
        # maximum" come out below the entry price, which no continuous path can
        # do. The gap is small (median 1.6 bp) but it would break the pathwise
        # identities M_up >= max(0,R) and M_dn <= min(0,R) that Stage B relies
        # on as a structural constraint.
        frames.append(
            pd.DataFrame(
                {
                    "anchor_ts": hour_ts[idx],
                    "H": H,
                    "s_tau": s_tau[idx],
                    "R": np.log(s_T[idx]) - ls,
                    "M_up": np.maximum(np.log(fwd_max[idx]) - ls, 0.0),
                    "M_dn": np.minimum(np.log(fwd_min[idx]) - ls, 0.0),
                    "M_up_clean": np.maximum(np.log(fwd_max_c[idx]) - ls, 0.0),
                    "M_dn_clean": np.minimum(np.log(fwd_min_c[idx]) - ls, 0.0),
                    "RV": np.sqrt(fwd_rv5[idx]),
                    "RV1": np.sqrt(fwd_rv1[idx]),
                    "row": idx,  # index back into `hours`, for feature joining
                }
            )
        )

    ep = pd.concat(frames, ignore_index=True)
    ep["dt"] = pd.to_datetime(ep["anchor_ts"], unit="s", utc=True)
    ep["anchor_hour"] = ep["dt"].dt.hour
    ep["dow"] = ep["dt"].dt.dayofweek
    return ep.sort_values(["anchor_ts", "H"], ignore_index=True)


def _sanity_checks(ep: pd.DataFrame) -> dict:
    """Pathwise identities that must hold on every real path."""
    viol_up = int((ep.M_up < np.maximum(ep.R, 0) - 1e-12).sum())
    viol_dn = int((ep.M_dn > np.minimum(ep.R, 0) + 1e-12).sum())
    return {
        "violations_M_up_lt_max0R": viol_up,
        "violations_M_dn_gt_min0R": viol_dn,
        "nonfinite_labels": int(
            (~np.isfinite(ep[["R", "M_up", "M_dn", "RV"]].to_numpy())).sum()
        ),
        "nonpositive_RV": int((ep.RV <= 0).sum()),
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Build clock-anchored episodes")
    p.add_argument("--parquet", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--horizons", type=int, nargs="+", default=list(DEFAULT_HORIZONS))
    a = p.parse_args(argv)
    a.out.mkdir(parents=True, exist_ok=True)

    print("[episodes] loading 1-minute bars ...")
    df = pd.read_parquet(a.parquet)

    print("[episodes] aggregating to hourly ...")
    hours = build_hourly(df)
    hours.to_parquet(a.out / "btcusd_1h.parquet", index=False, compression="zstd")

    print(f"[episodes] building episodes for horizons {a.horizons} ...")
    ep = build_episodes(hours, tuple(a.horizons))
    ep.to_parquet(a.out / "episodes.parquet", index=False, compression="zstd")

    report = {
        "hours": int(len(hours)),
        "hours_start_utc": str(hours.dt.iloc[0]),
        "hours_end_utc": str(hours.dt.iloc[-1]),
        "episodes_total": int(len(ep)),
        "episodes_by_H": {int(k): int(v) for k, v in ep.H.value_counts().sort_index().items()},
        "episodes_H19_anchor17": int(((ep.H == 19) & (ep.anchor_hour == 17)).sum()),
        **_sanity_checks(ep),
    }
    (a.out / "episodes_report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
