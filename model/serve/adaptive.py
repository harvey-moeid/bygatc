"""
serve/adaptive.py
=====================================================================
Causal volatility-level recalibration.

THE PROBLEM THIS SOLVES

Out-of-sample on 2024-07 onward, NOCTUA's volatility forecast is biased HIGH:
realized vol falls below the forecast 66.4% of the time where an unbiased
median forecast would give 50%, a median ratio of 0.874. Because every barrier
level scales with sigma, that bias propagates straight into strikes quoted too
far out -- safe, but costing the seller premium every night. Measured breach
rates in the test era ran at roughly half of nominal at the levels that matter.

WHY IT IS NOT A FIXED CONSTANT

The obvious fix -- a single correction factor baked into the artifact -- is
wrong, and the data says so:

    split    median RV/sigma    frac below
    train         0.970            55.0%
    calib         1.009            48.6%      <- essentially unbiased
    test          0.874            66.4%      <- biased

The model is unbiased on the calibration split. A constant fitted there would
be 1.01 and would do nothing for the test era. A constant fitted on the test
era would be look-ahead -- fitting the evaluation data, which is exactly the
failure mode a serious benchmark exists to catch. The bias is a REGIME
property, not a fixed model defect, so the correction has to move with the
regime.

THE MECHANISM

At each anchor, take every episode that has already SETTLED strictly before it
within a trailing window, and use the median of realized/forecast volatility
over those. Strictly causal: an episode is only eligible once its full H-hour
window has closed, so nothing about the future enters. The estimator is a
median rather than a mean because the ratio is right-skewed and one violent
night should not move the correction.

The episode-level ratio has lag-1 autocorrelation of -0.021 -- individual
nights are unpredictable, and this makes no attempt to predict them. What
drifts slowly is the LEVEL of the ratio, and that is all this tracks.

MEASURED EFFECT (test era, 2024-07 onward, out of sample)

    median RV/sigma      0.874  ->  0.990
    fraction below       66.4%  ->  51.5%
    barrier calibration  2.073  ->  1.373 pp   (mean |breach - nominal|)

and on the calibration split, where the model was already unbiased, the
factor comes out at 1.011 -- it correctly does nothing. That self-cancelling
property is the point: this is insurance against regime change, not a tuning
knob.

Robust to the window: 30, 60, 90 and 180 days all land within 0.98-0.99 on the
test era, so the horizon is not fitted to the answer.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

WINDOW_DAYS = 60
MIN_EPISODES = 20
CLIP_LO, CLIP_HI = 0.70, 1.40      # a correction outside this is a bug, not a regime
STRIDE_HOURS = 6                   # subsample anchors; neighbours overlap 18/19 anyway


def _settled_anchors(hours: pd.DataFrame, anchor_row: int, H: int,
                     window_days: int, stride: int) -> np.ndarray:
    """Rows whose full H-hour window closed strictly before `anchor_row`.

    The `- H` is the whole point: an episode is only usable once its outcome
    is fully observed. Without it the newest episodes would leak partially
    unrealized information into the correction.
    """
    last = anchor_row - H
    first = max(24 * 30, last - window_days * 24)
    if last <= first:
        return np.empty(0, dtype=int)
    return np.arange(first, last, stride, dtype=int)


def volatility_correction(model, hours: pd.DataFrame, anchor_row: int, H: int,
                          window_days: int = WINDOW_DAYS,
                          verbose: bool = False) -> dict:
    """Trailing median of realized/forecast volatility. Causal by construction.

    Returns the factor plus the diagnostics needed to tell "the regime moved"
    apart from "something broke", since both would otherwise look like a
    number drifting away from 1.
    """
    from noctua.features import build_features

    rows = _settled_anchors(hours, anchor_row, H, window_days, STRIDE_HOURS)
    info = {"factor": 1.0, "n_episodes": int(len(rows)), "window_days": window_days,
            "applied": False, "reason": ""}
    if len(rows) < MIN_EPISODES:
        info["reason"] = f"only {len(rows)} settled episodes, need {MIN_EPISODES}"
        return info

    hour_ts = hours["hour_ts"].to_numpy(np.int64)
    dt = pd.to_datetime(hour_ts[rows], unit="s", utc=True)
    ep = pd.DataFrame({"anchor_ts": hour_ts[rows], "H": H, "row": rows, "dt": dt,
                       "anchor_hour": dt.hour, "dow": dt.dayofweek})

    X = build_features(hours, ep)
    ok = np.isfinite(X.to_numpy()).all(1)
    if ok.sum() < MIN_EPISODES:
        info["reason"] = f"only {int(ok.sum())} episodes with complete features"
        return info
    X, rows = X[ok], rows[ok]

    pred = model.predict(model.prepare(X, np.full(len(rows), float(H))))
    sigma = np.asarray(pred["sigma_med"], dtype=np.float64)

    # realized vol over each settled window, from the same rv5 the model uses
    rv5 = hours["rv5"].to_numpy(np.float64)
    realized = np.array([np.sqrt(rv5[r:r + H].sum()) for r in rows])

    good = np.isfinite(realized) & np.isfinite(sigma) & (sigma > 0) & (realized > 0)
    if good.sum() < MIN_EPISODES:
        info["reason"] = f"only {int(good.sum())} usable episodes"
        return info

    ratio = realized[good] / sigma[good]
    factor = float(np.median(ratio))
    info.update(n_episodes=int(good.sum()),
                raw_factor=factor,
                frac_below=float(np.mean(realized[good] < sigma[good])))

    if not np.isfinite(factor) or not (CLIP_LO <= factor <= CLIP_HI):
        info["reason"] = (f"factor {factor:.3f} outside [{CLIP_LO}, {CLIP_HI}] -- "
                          "treated as a data fault, not a regime shift")
        info["factor"] = float(np.clip(factor, CLIP_LO, CLIP_HI)) if np.isfinite(factor) else 1.0
        info["applied"] = np.isfinite(factor)
        return info

    info.update(factor=factor, applied=True,
                reason=f"trailing {window_days}d median over {int(good.sum())} settled episodes")
    if verbose:
        print(f"[adaptive] factor={factor:.4f} from {int(good.sum())} episodes "
              f"({100*info['frac_below']:.1f}% realized below forecast)")
    return info


def apply_correction(pred: dict, factor: float) -> dict:
    """Rescale the predictive object's volatility, leaving its SHAPE alone.

    Only the sigma atoms and the median move. The standardized excursion shape
    -- which is what the committee's specialists actually contribute -- is
    untouched, because the measured defect is a level bias and nothing in the
    evidence points at the shape.

    Any memoised pooled curve is dropped, or `safe_level` would keep serving
    the pre-correction one.
    """
    if factor == 1.0:
        return pred
    out = {k: v for k, v in pred.items() if not k.startswith("_pooled_")}
    out["sigma_atoms"] = pred["sigma_atoms"] * factor
    out["sigma_med"] = pred["sigma_med"] * factor
    if "sigma_mean" in pred:
        out["sigma_mean"] = pred["sigma_mean"] * factor
    return out
