"""
noctua/committee.py
=====================================================================
NOCTUA v2: a committee of specialists, pooled by level-dependent
Vincentization.

WHY A COMMITTEE, AND WHY NOT A BIGGER MODEL
-------------------------------------------
The capacity study (model/artifacts/capacity_sweep.json) settled the "just add
parameters" question empirically, and it went the other way:

    hidden   params    QLIKE vs Log-HAR   barrier err
      32      6,378        -4.65%           2.706 pp     <- best on both
      64     16,778        -3.96%           2.778 pp
     128     49,866        -2.79%           2.926 pp     <- what v1 shipped
     256    165,194        -2.79%           3.133 pp
     512    592,458        -3.38%           2.938 pp

The reason is sample size, not architecture. A 19-hour window anchored hourly
overlaps its neighbour by 18/19, so the 189,831 training episodes are worth
only ~2,498 INDEPENDENT observations -- a 76x inflation. At width 128 the model
already carries 20 parameters per effective observation; at 1 M it would carry
~400. More capacity buys variance, not signal.

What DOES buy signal is heterogeneity. From the v1 walk-forward, the textbook
Gaussian first-passage baseline BEATS the neural model in the body of the
distribution while losing to it badly in the tail:

    alpha        1%     2%     5%    10%    20%    30%
    NOCTUA     0.94   1.38   2.48   3.69   4.09   4.11    (mean |err|, pp)
    Gaussian   3.33   3.53   3.77   2.71   2.01   3.69

Complementary competence across the barrier level is exactly the condition
under which combination helps. So the pooling weights here are a function of
the quantile level -- each specialist is trusted where it has demonstrated
competence, and the crossover is learned rather than assumed.

HOW THEY ARE POOLED
-------------------
Ranjan & Gneiting (2013) proved that a LINEAR pool of calibrated predictive
distributions is necessarily OVERDISPERSED, hence miscalibrated. Since
calibration is this project's entire product, linear (CDF) pooling is
disqualified. We use **Vincentization** instead -- averaging the QUANTILE
FUNCTIONS (Vincent 1912; Busetti 2017; Lichtendahl et al.):

    Q_pool(tau)  =  sum_k  w_k(tau) * Q_k(tau),     w_k(tau) >= 0,  sum_k w_k(tau) = 1

Quantile aggregation sits between the linear and logarithmic pool in
dispersion, retains sharpness, and -- decisive for us -- a convex combination
of monotone functions is monotone, so the pooled curve stays invertible and
`safe_level` remains exact.

Working in the ABSOLUTE excursion domain makes the whole thing collapse to one
line: if Q(tau) is the tau-quantile of the running maximum M, then the level
that is touched with probability alpha is simply Q(1 - alpha). Safe levels are
read straight off the pooled quantile function.

Weights are fitted per level by minimising PINBALL LOSS on a held-out
calibration split -- a proper scoring rule for the quantile, and a small convex
problem on the simplex.
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import minimize
from scipy.stats import norm

EPS = 1e-12

# Quantile levels at which the committee is pooled. These are 1 - alpha for the
# alphas an option seller actually trades, so the grid is dense where the money
# is (deep tail) and sparse in the body.
ALPHA_GRID = np.array([0.005, 0.01, 0.02, 0.05, 0.10, 0.20, 0.30, 0.50])
Q_LEVELS = 1.0 - ALPHA_GRID          # 0.995 ... 0.50



def _mix_over_sigma(z: np.ndarray, sigma_atoms: np.ndarray,
                    n_grid: int = 400) -> np.ndarray:
    """Integrate a standardized quantile curve over uncertainty about sigma.

    WHY THIS IS NECESSARY -- a diagnosed defect, not a refinement.

    NOCTUA's own `safe_level` mixes Stage B over 32 equal-probability atoms of
    Stage A's predictive distribution for sigma, i.e. it reports
    P(M >= u) = E_sigma[...]. The analytic specialists, written naively,
    condition on a single POINT estimate of sigma instead. A predictive
    distribution that conditions on a point estimate of a parameter is
    under-dispersed relative to one that integrates over it, so those
    specialists produced systematically TIGHT quantiles.

    Pooling a properly hierarchical forecast with three under-dispersed ones
    dragged the committee's levels too close to spot: at alpha = 5% the pooled
    level was touched 7.1% / 10.2% of the time instead of 5%.

    Given the standardized quantile curve z(tau) and atoms sigma_a, the mixed
    CDF of M = z * sigma is  F(u) = mean_a F_z(u / sigma_a).  We evaluate that
    on a grid and invert it back to quantiles at Q_LEVELS.
    """
    n, A = sigma_atoms.shape
    lo = float(z[-1]) * np.maximum(sigma_atoms.min(axis=1), EPS)
    hi = float(z[0]) * np.maximum(sigma_atoms.max(axis=1), EPS) * 1.5
    grid = np.linspace(lo, hi, n_grid).T                       # (n, G)

    # F_z is the CDF of the standardized excursion, known at Q_LEVELS
    z_asc, lev_asc = z[::-1], Q_LEVELS[::-1]                   # ascending

    cdf = np.zeros_like(grid)
    for a in range(A):
        ratio = grid / np.maximum(sigma_atoms[:, a], EPS)[:, None]
        cdf += np.interp(ratio, z_asc, lev_asc, left=0.0, right=1.0)
    cdf /= A

    out = np.empty((n, len(Q_LEVELS)))
    for i in range(n):
        out[i] = np.interp(Q_LEVELS, cdf[i], grid[i])
    return out


# ==========================================================================
# specialists -- each returns (n, len(ALPHA_GRID)) quantiles of the ABSOLUTE
# excursion M (log units), i.e. column j is the (1 - ALPHA_GRID[j]) quantile.
# ==========================================================================
class GaussianSpecialist:
    """Driftless-diffusion first passage: the textbook reflection principle.

    P(M >= u) = 2 * Phi(-u / sigma)  =>  Q(1-a) = -sigma * Phi^-1(a/2)

    Zero parameters, zero estimation variance, and per the table above it is
    the strongest member in the BODY of the distribution. Its weakness is
    equally structural: Gaussian tails cannot represent a crypto tail.
    """

    name = "gaussian"

    def fit(self, m_up, m_dn, sigma):
        return self

    def quantiles(self, sigma, up=True, sigma_atoms=None):
        z = -norm.ppf(ALPHA_GRID / 2.0)                     # (J,)
        if sigma_atoms is not None:
            return _mix_over_sigma(z, sigma_atoms)
        return np.maximum(sigma, EPS)[:, None] * z[None, :]


class EmpiricalSpecialist:
    """Fully non-parametric: the historical distribution of m = M / sigma.

    Inherits the true fat tails instead of assuming Gaussian ones, and assumes
    nothing about shape. Its weakness is the deep tail, where it is estimating
    a 1-in-200 quantile from a finite sample.
    """

    name = "empirical"

    def __init__(self):
        self.z_up = None
        self.z_dn = None

    def fit(self, m_up, m_dn, sigma):
        s = np.maximum(sigma, EPS)
        self.z_up = np.quantile(np.abs(m_up) / s, Q_LEVELS)
        self.z_dn = np.quantile(np.abs(m_dn) / s, Q_LEVELS)
        return self

    def quantiles(self, sigma, up=True, sigma_atoms=None):
        z = self.z_up if up else self.z_dn
        if sigma_atoms is not None:
            return _mix_over_sigma(z, sigma_atoms)
        return np.maximum(sigma, EPS)[:, None] * z[None, :]


class EVTSpecialist:
    """Peaks-over-threshold: a Generalised Pareto tail above a high threshold.

    Extreme-value theory says that for a broad class of distributions the
    EXCESS over a high threshold converges to a Generalised Pareto, whatever
    the parent distribution is. That is the right tool for extrapolating a
    1-in-100 or 1-in-200 barrier from a few thousand observations -- precisely
    the regime where the empirical quantile is noisiest and the Gaussian is
    simply wrong.

    Below the threshold the empirical distribution is used unchanged; above it,
    the fitted GPD. Shape parameter xi > 0 means a genuinely heavy tail.
    """

    name = "evt"

    def __init__(self, threshold_q: float = 0.90):
        self.tq = threshold_q
        self.par = {}

    @staticmethod
    def _fit_gpd(excess: np.ndarray) -> tuple[float, float]:
        """Fit GPD(xi, beta) to exceedances by maximum likelihood."""
        excess = excess[excess > 0]
        if len(excess) < 50:
            return 0.0, max(float(excess.mean()) if len(excess) else 1.0, EPS)

        def nll(p):
            xi, log_beta = p
            beta = np.exp(log_beta)
            if abs(xi) < 1e-6:
                return len(excess) * log_beta + excess.sum() / beta
            z = 1.0 + xi * excess / beta
            if np.any(z <= 0):
                return 1e12
            return len(excess) * log_beta + (1.0 + 1.0 / xi) * np.log(z).sum()

        best = minimize(nll, x0=[0.1, np.log(excess.mean())], method="Nelder-Mead",
                        options={"maxiter": 800, "xatol": 1e-6, "fatol": 1e-6})
        xi = float(np.clip(best.x[0], -0.5, 0.9))    # xi >= 1 has infinite mean
        beta = float(max(np.exp(best.x[1]), EPS))
        return xi, beta

    def _side(self, z: np.ndarray) -> dict:
        u = float(np.quantile(z, self.tq))
        xi, beta = self._fit_gpd(z - u)
        return {"u": u, "xi": xi, "beta": beta,
                "emp": np.quantile(z, np.minimum(Q_LEVELS, self.tq))}

    def fit(self, m_up, m_dn, sigma):
        s = np.maximum(sigma, EPS)
        self.par["up"] = self._side(np.abs(m_up) / s)
        self.par["dn"] = self._side(np.abs(m_dn) / s)
        return self

    def _z_at(self, side: str) -> np.ndarray:
        p = self.par[side]
        u, xi, beta, tq = p["u"], p["xi"], p["beta"], self.tq
        out = np.empty(len(Q_LEVELS))
        for j, q in enumerate(Q_LEVELS):
            if q <= tq:
                out[j] = p["emp"][j]
                continue
            # GPD quantile of the conditional excess distribution
            frac = (1.0 - q) / (1.0 - tq)
            if abs(xi) < 1e-6:
                out[j] = u + beta * (-np.log(frac))
            else:
                out[j] = u + (beta / xi) * (frac ** (-xi) - 1.0)
        # Q_LEVELS is DESCENDING, so the quantile vector must DESCEND. Using
        # maximum.accumulate here (the idiom that is correct for an ascending
        # grid) collapsed every level onto the 99.5% quantile, which made the
        # committee wildly over-conservative in the body of the distribution.
        return np.minimum.accumulate(out)

    def quantiles(self, sigma, up=True, sigma_atoms=None):
        z = self._z_at("up" if up else "dn")
        if sigma_atoms is not None:
            return _mix_over_sigma(z, sigma_atoms)
        return np.maximum(sigma, EPS)[:, None] * z[None, :]


class NeuralSpecialist:
    """The trained NOCTUA network, read as a quantile function of M.

    `safe_level(pred, alpha)` already inverts the mixed predictive survival
    curve, so the (1 - alpha) quantile of M is exactly the alpha-safe level --
    no extra machinery, and the numbers are produced by the same code the
    evaluation scored.
    """

    name = "neural"

    def __init__(self, model=None):
        self.model = model

    def fit(self, m_up, m_dn, sigma):
        return self

    def quantiles_from_pred(self, pred, up=True):
        from . import infer as I
        cols = [I.safe_level(pred, float(a), up=up) for a in ALPHA_GRID]
        return np.maximum.accumulate(np.stack(cols, axis=1)[:, ::-1], axis=1)[:, ::-1]


# ==========================================================================
# pooling
# ==========================================================================
def pinball(q: np.ndarray, y: np.ndarray, level: float) -> float:
    d = y - q
    return float(np.mean(np.maximum(level * d, (level - 1.0) * d)))


def fit_weights(Q: np.ndarray, y: np.ndarray, ridge: float = 0.005) -> np.ndarray:
    """Per-level simplex weights minimising pinball loss on held-out data.

    `Q` is (n_specialists, n_episodes, n_levels); `y` the realized excursion.
    Returns (n_specialists, n_levels).

    A small ridge pull toward EQUAL weights is applied deliberately. Forecast
    combination has a long-documented tendency for optimised weights to
    underperform the simple average out of sample -- the "forecast combination
    puzzle" -- because the weights are themselves estimated from limited, noisy
    data. Shrinking toward 1/K keeps the estimated edge without inheriting all
    of the estimation variance.
    """
    K, n, J = Q.shape
    W = np.full((K, J), 1.0 / K)
    eq = np.full(K, 1.0 / K)

    for j in range(J):
        lev = Q_LEVELS[j]
        Qj = Q[:, :, j]                                    # (K, n)

        def obj(w):
            return pinball(w @ Qj, y, lev) + ridge * float(np.sum((w - eq) ** 2))

        res = minimize(
            obj, x0=eq.copy(), method="SLSQP",
            bounds=[(0.0, 1.0)] * K,
            constraints=[{"type": "eq", "fun": lambda w: w.sum() - 1.0}],
            options={"maxiter": 500, "ftol": 1e-12},
        )
        w = np.clip(res.x, 0.0, None) if res.success else eq.copy()
        W[:, j] = w / max(w.sum(), EPS)
    return W


class Committee:
    """Level-dependent Vincentization of the specialist quantile functions."""

    def __init__(self, specialists, ridge: float = 0.005):
        self.specialists = list(specialists)
        self.ridge = ridge
        self.W_up = None
        self.W_dn = None

    @property
    def names(self):
        return [s.name for s in self.specialists]

    def _stack(self, sigma, pred, up):
        cols = []
        for s in self.specialists:
            if isinstance(s, NeuralSpecialist):
                cols.append(s.quantiles_from_pred(pred, up=up))
            else:
                cols.append(s.quantiles(sigma, up=up,
                                        sigma_atoms=pred.get("sigma_atoms")))
        return np.stack(cols, axis=0)                      # (K, n, J)

    def fit(self, sigma, pred, m_up, m_dn):
        self.W_up = fit_weights(self._stack(sigma, pred, True), np.abs(m_up), self.ridge)
        self.W_dn = fit_weights(self._stack(sigma, pred, False), np.abs(m_dn), self.ridge)
        return self

    def fit_equal(self):
        """Fix every weight at 1/K, fitting nothing.

        This is the estimator the ARTIFACT actually ships -- `NoctuaV2.
        committee_quantiles` hard-codes 0.25 per specialist. Scoring only the
        SLSQP-fitted variant would report a number produced by a different
        estimator from the released one, however close the two turn out to be,
        so both are evaluated side by side and the equal-weight column is the
        one quoted as the headline.
        """
        K, J = len(self.specialists), len(ALPHA_GRID)
        self.W_up = np.full((K, J), 1.0 / K)
        self.W_dn = np.full((K, J), 1.0 / K)
        return self

    def quantiles(self, sigma, pred, up=True) -> np.ndarray:
        Q = self._stack(sigma, pred, up)
        W = self.W_up if up else self.W_dn
        pooled = np.einsum("kj,knj->nj", W, Q)
        # a convex combination of monotone curves is monotone; enforce against
        # floating-point noise only
        return np.maximum.accumulate(pooled[:, ::-1], axis=1)[:, ::-1]

    def safe_level(self, sigma, pred, alpha: float, up=True) -> np.ndarray:
        """The level touched with probability `alpha` -- read straight off the
        pooled quantile function at 1 - alpha."""
        Qp = self.quantiles(sigma, pred, up)
        j = int(np.argmin(np.abs(ALPHA_GRID - alpha)))
        if abs(ALPHA_GRID[j] - alpha) < 1e-9:
            return Qp[:, j]
        return np.array([np.interp(1.0 - alpha, Q_LEVELS[::-1], row[::-1]) for row in Qp])

    def to_dict(self) -> dict:
        return {"names": self.names, "alpha_grid": ALPHA_GRID.tolist(),
                "W_up": self.W_up.tolist(), "W_dn": self.W_dn.tolist()}


# ==========================================================================
# NOCTUA-as-parent: a gating network over the specialist children
# ==========================================================================
# The flat Committee above weights each specialist by quantile level, but those
# weights are the SAME for every episode. The natural generalisation -- and the
# rigorous form of "the parent spawns children and decides what to do with
# their answers" -- is a hierarchical mixture of experts (Jacobs, Jordan,
# Nowlan & Hinton 1991): a small GATING network reads the current market state
# and produces per-episode weights over the children.
#
# The gate is deliberately tiny. The capacity study showed this problem carries
# ~2,498 effective independent observations, so a large gate would simply
# rediscover the overfitting the committee exists to avoid. It is also
# initialised at EXACTLY equal weights (W = 0, b = 0 => softmax is uniform),
# so training starts at the flat committee and the gate can only be credited
# with what it adds -- the same discipline used for Stage A's Log-HAR base.
GATE_FEATURES = [
    "har_1d",            # current volatility level
    "vov_22d",           # volatility of volatility -- how unstable is the regime
    "reg_rv_vs_year",    # where this vol sits against its own year
    "cal_weekend_frac",  # the dominant calendar effect
    "jump_share_1d",     # how much of recent variance was jumps, not diffusion
]


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / np.maximum(e.sum(axis=1, keepdims=True), EPS)


class GatedCommittee:
    """Context-dependent Vincentization: weights depend on the market state.

    w_k(x) = softmax(x @ W + b)_k, shared across quantile levels so the gate
    answers "which child do I trust RIGHT NOW", while the flat Committee
    answers "which child do I trust at THIS alpha". Both can be combined, but
    they are evaluated separately here so the contribution of each is legible.
    """

    def __init__(self, specialists, l2: float = 1.0):
        self.specialists = list(specialists)
        self.l2 = l2
        self.W = None
        self.b = None
        self.mu = None
        self.sd = None

    @property
    def names(self):
        return [s.name for s in self.specialists]

    def _stack(self, sigma, pred, up):
        cols = []
        for s in self.specialists:
            if isinstance(s, NeuralSpecialist):
                cols.append(s.quantiles_from_pred(pred, up=up))
            else:
                cols.append(s.quantiles(sigma, up=up, sigma_atoms=pred.get("sigma_atoms")))
        return np.stack(cols, axis=0)

    def _std(self, G):
        return np.nan_to_num((G - self.mu) / self.sd, nan=0.0, posinf=0.0, neginf=0.0)

    def fit(self, G, sigma, pred, m_up, m_dn):
        self.mu = np.nanmean(G, axis=0)
        self.sd = np.where(np.nanstd(G, axis=0) < 1e-8, 1.0, np.nanstd(G, axis=0))
        Gs = self._std(G)
        F, K = Gs.shape[1], len(self.specialists)

        Qu = self._stack(sigma, pred, True)
        Qd = self._stack(sigma, pred, False)
        yu, yd = np.abs(m_up), np.abs(m_dn)

        def loss(theta):
            W = theta[: F * K].reshape(F, K)
            b = theta[F * K:]
            w = _softmax(Gs @ W + b)                       # (n, K)
            tot = 0.0
            for Q, y in ((Qu, yu), (Qd, yd)):
                pooled = np.einsum("nk,knj->nj", w, Q)     # (n, J)
                d = y[:, None] - pooled
                tot += np.mean(np.maximum(Q_LEVELS * d, (Q_LEVELS - 1.0) * d))
            return tot + self.l2 * float(np.sum(W ** 2))

        theta0 = np.zeros(F * K + K)                       # == equal weights
        res = minimize(loss, theta0, method="L-BFGS-B",
                       options={"maxiter": 300, "ftol": 1e-12})
        th = res.x if res.success else theta0
        self.W = th[: F * K].reshape(F, K)
        self.b = th[F * K:]
        return self

    def weights(self, G):
        return _softmax(self._std(G) @ self.W + self.b)

    def quantiles(self, G, sigma, pred, up=True):
        Q = self._stack(sigma, pred, up)
        pooled = np.einsum("nk,knj->nj", self.weights(G), Q)
        return np.maximum.accumulate(pooled[:, ::-1], axis=1)[:, ::-1]

    def safe_level(self, G, sigma, pred, alpha: float, up=True):
        Qp = self.quantiles(G, sigma, pred, up)
        j = int(np.argmin(np.abs(ALPHA_GRID - alpha)))
        if abs(ALPHA_GRID[j] - alpha) < 1e-9:
            return Qp[:, j]
        return np.array([np.interp(1.0 - alpha, Q_LEVELS[::-1], r[::-1]) for r in Qp])
