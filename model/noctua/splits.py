"""
noctua/splits.py
=====================================================================
Train / calibrate / test partitioning with an embargo.

Two rules, both non-negotiable:

1. **Purge.** Episodes overlap: a 19-hour window opened at 17:00 shares minutes
   with the window opened at 18:00. If a split boundary cuts through that
   overlap, a test label is partly observable from a training window. Every
   boundary is therefore embargoed by `max(H)` hours on BOTH sides.

2. **Headline on non-overlapping anchors.** All-anchor episodes are used for
   TRAINING (the section 3.4 augmentation). Reported out-of-sample numbers are
   computed only on the production slice -- H = 19 h, anchor 17:00 UTC, one per
   calendar day -- because that is the trade the user actually makes, and
   because significance on overlapping windows is an illusion.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

HOUR = 3600
SAMPLE_START = "2017-08-01"

# development split
TRAIN_END = "2023-01-01"
CALIB_END = "2024-07-01"

PROD_H = 19
PROD_ANCHOR = 17


def in_sample_mask(ep: pd.DataFrame, start: str = SAMPLE_START) -> np.ndarray:
    """Restrict to the modern-microstructure sample (see RESEARCH_PLAN 3.2)."""
    return (ep["dt"] >= pd.Timestamp(start, tz="UTC")).to_numpy()


def production_mask(ep: pd.DataFrame) -> np.ndarray:
    """The actual trade: 19h window opened at 17:00 UTC."""
    return ((ep["H"] == PROD_H) & (ep["anchor_hour"] == PROD_ANCHOR)).to_numpy()


def time_splits(
    ep: pd.DataFrame,
    train_end: str = TRAIN_END,
    calib_end: str = CALIB_END,
    embargo_hours: int | None = None,
) -> dict[str, np.ndarray]:
    """Boolean masks for train / calib / test, embargoed at each boundary."""
    if embargo_hours is None:
        embargo_hours = int(ep["H"].max())
    emb = embargo_hours * HOUR

    ts = ep["anchor_ts"].to_numpy(np.int64)
    t1 = int(pd.Timestamp(train_end, tz="UTC").timestamp())
    t2 = int(pd.Timestamp(calib_end, tz="UTC").timestamp())
    base = in_sample_mask(ep)

    return {
        # a training window must END before the boundary, hence the -emb
        "train": base & (ts + ep["H"].to_numpy() * HOUR <= t1 - emb),
        "calib": base & (ts >= t1) & (ts + ep["H"].to_numpy() * HOUR <= t2 - emb),
        "test": base & (ts >= t2),
    }


def walk_forward_folds(
    ep: pd.DataFrame,
    first_test_year: int = 2021,
    last_test_year: int = 2026,
    embargo_hours: int | None = None,
) -> list[dict]:
    """Expanding-window folds: train on everything before year Y, test on Y.

    The calibration slice is the final 6 months of the training period, so the
    recalibration layer is always fitted out-of-sample with respect to the
    model weights but in-sample with respect to time.
    """
    if embargo_hours is None:
        embargo_hours = int(ep["H"].max())
    emb = embargo_hours * HOUR
    ts = ep["anchor_ts"].to_numpy(np.int64)
    end = ts + ep["H"].to_numpy() * HOUR
    base = in_sample_mask(ep)

    folds = []
    for y in range(first_test_year, last_test_year + 1):
        t_test = int(pd.Timestamp(f"{y}-01-01", tz="UTC").timestamp())
        t_cal = int(pd.Timestamp(f"{y - 1}-07-01", tz="UTC").timestamp())
        t_next = int(pd.Timestamp(f"{y + 1}-01-01", tz="UTC").timestamp())
        m_test = base & (ts >= t_test) & (ts < t_next)
        if m_test.sum() == 0:
            continue
        folds.append(
            {
                "year": y,
                "train": base & (end <= t_cal - emb),
                "calib": base & (ts >= t_cal) & (end <= t_test - emb),
                "test": m_test,
            }
        )
    return folds


def sample_weights(ep: pd.DataFrame, mask: np.ndarray, half_life_days: float = 900.0) -> np.ndarray:
    """Exponential time decay.

    RESEARCH_PLAN 3.3: the spot-ETF launch compressed realized vol ~30%. Rather
    than hard-cut the pre-ETF era (which would throw away most of the sample),
    down-weight it smoothly so recent microstructure dominates the fit.
    """
    ts = ep["anchor_ts"].to_numpy(np.float64)[mask]
    age_days = (ts.max() - ts) / 86400.0
    return np.exp(-np.log(2.0) * age_days / half_life_days)
