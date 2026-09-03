"""
noctua/calibrate.py
=====================================================================
Stage C: distributional recalibration.

Motivation (measured, not assumed). The raw model's first out-of-sample run
showed a specific, systematic defect: it under-forecasts DOWNSIDE excursions.
At a target alpha of 5% the downside level it called "safe" actually broke 7.9%
of the time, and its 5th-percentile return quantile was breached 9.0% of the
time. Upside calibration was good. That asymmetry is the leverage/crash effect
-- BTC falls faster than it rises -- and a model that misses it hands an option
seller a put strike that is too close.

Method: PIT recalibration (Kuleshov, Fenner & Ermon 2018). For a well-specified
predictive CDF F, the probability integral transform F(y_actual) is Uniform(0,1)
out of sample. It is not, here. So we estimate the empirical CDF of the PIT
values on a HELD-OUT calibration split and compose it with the raw forecast:

        F_calibrated(x) = ecdf_PIT( F_raw(x) )

This is monotone, so it cannot create quantile crossing, and it is exactly
invertible, so the "safe level" inversion still works. It is fitted on data the
model never trained on, and evaluated on data used for neither.

Calibration is fitted on the STANDARDIZED functionals after mixing over Stage
A's volatility uncertainty, i.e. on the object the user is actually served.
"""
from __future__ import annotations

import numpy as np

from . import infer as I

GRID = np.linspace(0.0, 1.0, 257)


class PITCalibrator:
    """Monotone recalibration map for one predicted distribution."""

    def __init__(self):
        self.grid = GRID
        self.map = GRID.copy()      # identity until fitted
        self.fitted = False

    def fit(self, pit: np.ndarray) -> "PITCalibrator":
        """`pit` = F_raw(y_actual) on held-out data. Ideally Uniform(0,1)."""
        pit = np.clip(np.asarray(pit, dtype=np.float64), 0.0, 1.0)
        pit = pit[np.isfinite(pit)]
        if len(pit) < 50:
            return self
        s = np.sort(pit)
        # ecdf evaluated on the grid, with the endpoints pinned so the map
        # stays a valid CDF transform
        m = np.searchsorted(s, self.grid, side="right") / len(s)
        m[0], m[-1] = 0.0, 1.0
        self.map = np.maximum.accumulate(m)
        self.fitted = True
        return self

    def effective_map(self, shrink: float = 1.0) -> np.ndarray:
        """Blend the fitted map toward the identity.

        shrink = 0 -> no correction at all; shrink = 1 -> the full fitted map.
        Shrinkage exists because the first walk-forward run showed the PIT
        correction does NOT transfer across volatility regimes: the sign of the
        tail miscalibration flips between the calibration and test periods, so
        applying the full correction can be worse than applying none.
        """
        if not self.fitted or shrink <= 0.0:
            return self.grid
        return (1.0 - shrink) * self.grid + shrink * self.map

    def cdf(self, f_raw: np.ndarray, shrink: float = 1.0) -> np.ndarray:
        return np.interp(np.clip(f_raw, 0.0, 1.0), self.grid, self.effective_map(shrink))

    def inv(self, f_cal: np.ndarray) -> np.ndarray:
        """Raw CDF level needed to achieve a calibrated level."""
        return np.interp(np.clip(f_cal, 0.0, 1.0), self.map, self.grid)

    def to_dict(self) -> dict:
        return {"grid": self.grid.tolist(), "map": self.map.tolist(), "fitted": self.fitted}

    @classmethod
    def from_dict(cls, d: dict) -> "PITCalibrator":
        c = cls()
        c.grid = np.asarray(d["grid"], dtype=np.float64)
        c.map = np.asarray(d["map"], dtype=np.float64)
        c.fitted = bool(d["fitted"])
        return c


# Production shrinkage, selected by the walk-forward sweep in
# model/artifacts/walkforward.json. shrink=0.5 minimises mean |calibration
# error| across alpha (2.78pp vs the Gaussian baseline's 3.17pp) while staying
# close to the best deep-tail setting. Full correction (shrink=1.0) is
# marginally better at alpha<=2% but degrades the body.
DEFAULT_SHRINK = 0.5


class NoctuaCalibration:
    """The three recalibration maps NOCTUA serves through."""

    def __init__(self, shrink: float = DEFAULT_SHRINK):
        self.up = PITCalibrator()
        self.dn = PITCalibrator()
        self.ret = PITCalibrator()
        self.shrink = float(shrink)

    def fit(self, pred: dict, M_up: np.ndarray, M_dn: np.ndarray, R: np.ndarray):
        # PIT of the actual excursion under the raw mixed predictive CDF
        self.up.fit(1.0 - I.touch_prob(pred, np.abs(M_up), up=True))
        self.dn.fit(1.0 - I.touch_prob(pred, np.abs(M_dn), up=False))

        # For the terminal return the mixed CDF is evaluated directly
        q = pred["q_r"]
        sig = pred["sigma_atoms"]
        acc = np.zeros(len(R))
        for a in range(q.shape[1]):
            z = R / np.maximum(sig[:, a], 1e-12)
            acc += I.survival_from_quantiles(q[:, a, :], z)
        self.ret.fit(1.0 - acc / q.shape[1])
        return self

    # ---- calibrated versions of the served quantities ---------------------
    def touch_prob(self, pred: dict, u: np.ndarray, up: bool = True) -> np.ndarray:
        raw = I.touch_prob(pred, u, up=up)
        cal = self.up if up else self.dn
        return np.clip(1.0 - cal.cdf(1.0 - raw, self.shrink), 0.0, 1.0)

    def safe_level(self, pred: dict, alpha: float, up: bool = True,
                   lo: float = 1e-5, hi: float = 2.0, iters: int = 36) -> np.ndarray:
        """Level whose CALIBRATED touch probability is alpha.

        Because the recalibration map is monotone we could invert it directly,
        but bisecting the composed curve is simpler and equally exact.
        """
        n = pred["sigma_atoms"].shape[0]
        a = np.full(n, lo)
        b = np.full(n, hi)
        for _ in range(iters):
            m = 0.5 * (a + b)
            risky = self.touch_prob(pred, m, up) > alpha
            a = np.where(risky, m, a)
            b = np.where(risky, b, m)
        return 0.5 * (a + b)

    def to_dict(self) -> dict:
        return {"up": self.up.to_dict(), "dn": self.dn.to_dict(),
                "ret": self.ret.to_dict(), "shrink": self.shrink}

    @classmethod
    def from_dict(cls, d: dict) -> "NoctuaCalibration":
        c = cls(shrink=float(d.get("shrink", DEFAULT_SHRINK)))
        c.up = PITCalibrator.from_dict(d["up"])
        c.dn = PITCalibrator.from_dict(d["dn"])
        c.ret = PITCalibrator.from_dict(d["ret"])
        return c


def pit_uniformity(pit: np.ndarray, n_bins: int = 10) -> dict:
    """Kolmogorov-Smirnov style summary of how far the PIT is from uniform."""
    p = np.sort(np.clip(pit[np.isfinite(pit)], 0.0, 1.0))
    n = len(p)
    if n == 0:
        return {"n": 0}
    ks = float(np.max(np.abs(p - (np.arange(1, n + 1) - 0.5) / n)))
    hist, _ = np.histogram(p, bins=n_bins, range=(0.0, 1.0))
    return {
        "n": int(n),
        "ks": ks,
        "ks_crit_5pct": float(1.358 / np.sqrt(n)),
        "hist": (hist / n * n_bins).round(3).tolist(),  # 1.0 == uniform
    }
