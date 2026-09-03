"""
noctua/baselines.py
=====================================================================
Stage 4: the bar NOCTUA has to clear.

Per RESEARCH_PLAN section 2.3, the adversary is NOT Kronos and certainly not a
random walk -- it is a well-specified Log-HAR, which eight of nine zero-shot
foundation models failed to beat in arXiv:2607.05291. Everything here is
fitted on the training split only and scored out-of-sample.

Volatility baselines (target: log hourly vol RATE over the forward window,
    y = log(RV) - 0.5*log(H), so horizons are comparable)
    log_har     Corsi (2009) cascade in logs                  <- PRIMARY BAR
    har         Corsi cascade in variance levels
    har_rs      Patton-Sheppard realized semivariance
    harq        Bollerslev-Patton-Quaedvlieg quarticity-attenuated
    ewma        RiskMetrics, lambda = 0.94
    constant    trailing mean of y

Barrier baselines (target: P(M+ >= u), P(M- <= l))
    reflection  driftless Gaussian first-passage, 2*Phi(-u/sigma), at a HAR
                sigma. This is the textbook answer and a genuinely strong
                baseline -- section 2.4(ii) showed the Brownian median is very
                nearly right.
    empirical   historical distribution of the standardized excursion m = M/RV,
                a fully non-parametric competitor
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import norm

EPS = 1e-12


# --------------------------------------------------------------------------
# metrics
# --------------------------------------------------------------------------
def qlike(pred_var: np.ndarray, real_var: np.ndarray) -> float:
    """QLIKE loss. Robust to noise in the volatility proxy; lower is better."""
    r = np.maximum(real_var, EPS) / np.maximum(pred_var, EPS)
    return float(np.mean(r - np.log(r) - 1.0))


def mse_log(pred_log: np.ndarray, real_log: np.ndarray) -> float:
    return float(np.mean((pred_log - real_log) ** 2))


def r2_log(pred_log: np.ndarray, real_log: np.ndarray) -> float:
    ss = np.sum((real_log - pred_log) ** 2)
    tt = np.sum((real_log - real_log.mean()) ** 2)
    return float(1.0 - ss / tt)


def pinball(pred_q: np.ndarray, y: np.ndarray, levels: np.ndarray) -> float:
    """Mean pinball loss. pred_q: (n, k) quantile forecasts at `levels`."""
    d = y[:, None] - pred_q
    return float(np.mean(np.maximum(levels[None, :] * d, (levels[None, :] - 1.0) * d)))


def crps_from_quantiles(pred_q: np.ndarray, y: np.ndarray, levels: np.ndarray) -> float:
    """CRPS approximated by the quantile decomposition: CRPS = 2 * mean pinball."""
    return 2.0 * pinball(pred_q, y, levels)


def brier(p: np.ndarray, outcome: np.ndarray) -> float:
    return float(np.mean((p - outcome.astype(np.float64)) ** 2))


def log_loss(p: np.ndarray, outcome: np.ndarray, eps: float = 1e-6) -> float:
    p = np.clip(p, eps, 1.0 - eps)
    o = outcome.astype(np.float64)
    return float(-np.mean(o * np.log(p) + (1.0 - o) * np.log(1.0 - p)))


# --------------------------------------------------------------------------
# volatility baselines
# --------------------------------------------------------------------------
class OLS:
    """Plain least squares with an intercept, fitted on complete cases only."""

    def __init__(self, cols: list[str]):
        self.cols = cols
        self.beta: np.ndarray | None = None

    def fit(self, X: pd.DataFrame, y: np.ndarray, w: np.ndarray | None = None):
        A = X[self.cols].to_numpy(np.float64)
        ok = np.isfinite(A).all(1) & np.isfinite(y)
        A, yy = A[ok], y[ok]
        A = np.column_stack([np.ones(len(A)), A])
        if w is not None:
            sw = np.sqrt(w[ok])[:, None]
            self.beta, *_ = np.linalg.lstsq(A * sw, yy * sw[:, 0], rcond=None)
        else:
            self.beta, *_ = np.linalg.lstsq(A, yy, rcond=None)
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        A = X[self.cols].to_numpy(np.float64)
        A = np.column_stack([np.ones(len(A)), A])
        return A @ self.beta


def har_target(RV: np.ndarray, H: np.ndarray) -> np.ndarray:
    """log hourly volatility RATE over the forward window."""
    return np.log(np.maximum(RV, EPS)) - 0.5 * np.log(np.maximum(H, 1))


VOL_BASELINES: dict[str, list[str]] = {
    # PRIMARY BAR: Corsi's cascade, in logs
    "log_har": ["har_1d", "har_5d", "har_22d"],
    # + horizon and the dominant calendar effect, a fairer "well-specified" bar
    "log_har_cal": ["har_1d", "har_5d", "har_22d", "cal_H", "cal_weekend_frac"],
    "har_rs": ["har_1d", "har_5d", "har_22d", "semi_neg_1d", "semi_signed_jump_1d"],
    "harq": ["har_1d", "har_5d", "har_22d", "rq_noise_1d"],
    "har_short": ["har_1h", "har_6h", "har_1d", "har_5d", "har_22d"],
    "constant": [],
}


def fit_vol_baselines(
    Xtr: pd.DataFrame, ytr: np.ndarray, wtr: np.ndarray | None = None
) -> dict[str, OLS]:
    return {k: OLS(v).fit(Xtr, ytr, wtr) for k, v in VOL_BASELINES.items()}


def ewma_vol(har_1d: np.ndarray, har_5d: np.ndarray, har_22d: np.ndarray) -> np.ndarray:
    """RiskMetrics-style exponential blend of the cascade (lambda = 0.94).

    Weights approximate an EWMA with a ~1-month effective memory when applied
    to the 1d/5d/22d log-variance rates.
    """
    return 0.60 * har_1d + 0.28 * har_5d + 0.12 * har_22d


# --------------------------------------------------------------------------
# barrier baselines
# --------------------------------------------------------------------------
def reflection_touch_prob(u: np.ndarray, sigma: np.ndarray) -> np.ndarray:
    """P(max of a driftless Brownian path over the window >= u), u > 0.

    Reflection principle: P(M+ >= u) = 2 * Phi(-u / sigma), with sigma the
    TOTAL volatility over the window (not a rate).
    """
    z = np.abs(u) / np.maximum(sigma, EPS)
    return np.clip(2.0 * norm.cdf(-z), 0.0, 1.0)


class EmpiricalExcursion:
    """Non-parametric barrier model.

    Learns the training distribution of the standardized excursion m = M / RV
    and applies it to a predicted RV. This is a strong competitor precisely
    because RESEARCH_PLAN section 2.4(ii) showed the standardization works: it
    inherits the true fat tails instead of assuming Gaussian ones.
    """

    def __init__(self, grid: np.ndarray | None = None):
        self.grid = grid if grid is not None else np.linspace(0.0, 8.0, 801)
        self.surv_up: np.ndarray | None = None
        self.surv_dn: np.ndarray | None = None

    def fit(self, M_up: np.ndarray, M_dn: np.ndarray, RV: np.ndarray):
        mu = M_up / np.maximum(RV, EPS)
        md = -M_dn / np.maximum(RV, EPS)
        self.surv_up = 1.0 - np.searchsorted(np.sort(mu), self.grid, "right") / len(mu)
        self.surv_dn = 1.0 - np.searchsorted(np.sort(md), self.grid, "right") / len(md)
        return self

    def touch_prob(self, u: np.ndarray, sigma: np.ndarray, up: bool = True) -> np.ndarray:
        s = self.surv_up if up else self.surv_dn
        z = np.abs(u) / np.maximum(sigma, EPS)
        return np.interp(z, self.grid, s, left=1.0, right=float(s[-1]))
