"""
noctua/infer.py
=====================================================================
Turning the two heads into the objects an option seller actually uses.

The central operation is the mixing integral

    P(M >= u)  =  E_sigma [ 1 - F_{m|sigma}( u / sigma ) ]

evaluated as a deterministic quadrature over `N_ATOMS` equal-probability atoms
drawn from Stage A's predictive quantiles. Contrast with sampling a generative
model: 24 Monte-Carlo rollouts give a 5% tail probability a standard error of
+-4.4pp (RESEARCH_PLAN section 2.2(a)); this sum has NO sampling error at all,
and costs microseconds.

Tail handling
-------------
The quantile grid spans 0.005 to 0.995. Outside it the survival function is
extrapolated EXPONENTIALLY using the local quantile spacing rather than clipped
to 0/1. Clipping would silently claim that levels beyond the grid can never be
touched -- exactly the error that bankrupts an option seller.
"""
from __future__ import annotations

import numpy as np

from .spec import LEVELS, MEDIAN_IDX

# NOTE: torch is imported LAZILY inside predict(), not at module scope.
#
# Everything else in this module -- the survival function, the mixing integral,
# the barrier inversion -- is pure NumPy, and `serve/runtime.py` imports those
# helpers so the served numbers come from exactly the same code the evaluation
# used. A module-level `import torch` would drag a ~2 GB dependency into the
# Hugging Face Space and the GitHub Action, both of which install NumPy + SciPy
# only. That is not hypothetical: it shipped, and CI caught it -- the local
# test suite passed because torch happens to be installed in the training
# environment. test_serving.py now asserts torch stays unimported.

EPS = 1e-12
N_ATOMS = 32
ATOM_LEVELS = (np.arange(N_ATOMS) + 0.5) / N_ATOMS


def survival_from_quantiles(q: np.ndarray, x: np.ndarray) -> np.ndarray:
    """P(X >= x) given monotone quantiles `q` (n, K) evaluated at LEVELS.

    Fully vectorised. Linear interpolation inside the grid; exponential tail
    extrapolation outside it.
    """
    n, K = q.shape
    rows = np.arange(n)

    idx = np.clip((q < x[:, None]).sum(axis=1), 1, K - 1)
    q_lo, q_hi = q[rows, idx - 1], q[rows, idx]
    l_lo, l_hi = LEVELS[idx - 1], LEVELS[idx]
    t = (x - q_lo) / np.maximum(q_hi - q_lo, EPS)
    F = l_lo + t * (l_hi - l_lo)

    # --- upper tail: x beyond the largest quantile -------------------------
    top_gap = np.maximum(q[:, -1] - q[:, -2], EPS)
    over = x - q[:, -1]
    F_hi = 1.0 - (1.0 - LEVELS[-1]) * np.exp(-np.maximum(over, 0.0) / top_gap)

    # --- lower tail: x below the smallest quantile -------------------------
    bot_gap = np.maximum(q[:, 1] - q[:, 0], EPS)
    under = q[:, 0] - x
    F_lo = LEVELS[0] * np.exp(-np.maximum(under, 0.0) / bot_gap)

    F = np.where(x > q[:, -1], F_hi, np.where(x < q[:, 0], F_lo, F))
    return np.clip(1.0 - F, 0.0, 1.0)


def quantiles_at(q: np.ndarray, levels: np.ndarray) -> np.ndarray:
    """Resample a (n, K) quantile matrix onto arbitrary `levels`."""
    return np.stack([np.interp(levels, LEVELS, row) for row in q])


# Production ensemble weight on NOCTUA's volatility level, the rest going to
# Log-HAR. Chosen by a walk-forward sweep (model/artifacts/blend_sweep.json):
# w=0.25 gave pooled QLIKE -2.79% vs Log-HAR, p=0.043, winning 5 of 6 folds,
# with the worst fold bounded at +6.7% instead of the +72.3% that pure NOCTUA
# suffered in the 2023 volatility collapse. Ensembling a small model with a
# well-specified econometric benchmark is also the remedy arXiv:2607.05291
# recommends after finding the same fragility across 50 assets.
BLEND_W = 0.25


def predict(model, d: dict, n_atoms: int = N_ATOMS,
            har_logvol: np.ndarray | None = None, blend_w: float = BLEND_W) -> dict:
    """Full predictive object for a batch of episodes (PyTorch model).

    Serving does not go through here -- `serve.runtime.NumpyNoctua.predict`
    is the NumPy equivalent, verified to agree with this to ~1e-6.

    If `har_logvol` (the Log-HAR forecast of the log hourly vol rate) is given,
    Stage A's whole predictive distribution is SHIFTED so its median lands on
    the ensemble level. Shifting the distribution rather than only the point
    forecast means the barrier curves inherit the robust volatility level too,
    which is the point of the ensemble.
    """
    import torch  # lazy: keeps this module importable without PyTorch

    with torch.no_grad():
        Xa = torch.tensor(d["Xa"])
        Xb = torch.tensor(d["Xb"])
        Xs = torch.tensor(d["Xs"])
        H = np.asarray(d["H"], dtype=np.float64)

        qa = model.a(Xa, Xb).numpy().astype(np.float64)      # (n, K) log vol rate
        if har_logvol is not None and blend_w < 1.0:
            shift = (1.0 - blend_w) * (
                np.asarray(har_logvol, dtype=np.float64) - qa[:, MEDIAN_IDX]
            )
            qa = qa + shift[:, None]
        atom_levels = (np.arange(n_atoms) + 0.5) / n_atoms
        atoms_y = quantiles_at(qa, atom_levels)              # (n, A)
        sigma_atoms = np.exp(atoms_y) * np.sqrt(H)[:, None]  # (n, A) window vol

        qr, qu, qd = [], [], []
        for i in range(n_atoms):
            ls = torch.tensor(
                np.log(np.maximum(sigma_atoms[:, i], EPS)).astype(np.float32)
            )[:, None]
            a_, b_, c_ = model.b(Xs, ls)
            qr.append(a_.numpy()); qu.append(b_.numpy()); qd.append(c_.numpy())

    # Point forecasts. These are NOT interchangeable, and using the wrong one
    # is a real trap: QLIKE (and any squared-error loss on variance) is
    # minimised by the conditional MEAN of the variance, not its median. For a
    # roughly lognormal volatility with residual sd s, the median understates
    # the mean variance by exp(2 s^2) -- about 28% at s = 0.35. Measured here,
    # though, the mean OVER-forecasts (ratio 1.205) and scores worse, so the
    # median is what the evaluation reports; both are returned.
    var_mean = np.mean(np.exp(2.0 * atoms_y), axis=1) * H
    return {
        "qa": qa,
        "sigma_atoms": sigma_atoms,
        "sigma_med": np.exp(qa[:, MEDIAN_IDX]) * np.sqrt(H),
        "sigma_mean": np.sqrt(var_mean),
        "q_r": np.stack(qr, 1).astype(np.float64),       # (n, A, K)
        "q_up": np.stack(qu, 1).astype(np.float64),
        "q_dn": np.stack(qd, 1).astype(np.float64),
        "H": H,
    }


def touch_prob(pred: dict, u: np.ndarray, up: bool = True) -> np.ndarray:
    """P(the level `u` log-units away is touched during the window).

    `u` > 0 is a log-distance: 0.02 means a strike 2.02% above (or below) spot.
    """
    q = pred["q_up"] if up else pred["q_dn"]
    sig = pred["sigma_atoms"]
    u = np.abs(np.asarray(u, dtype=np.float64))
    if u.ndim == 0:
        u = np.full(q.shape[0], float(u))
    acc = np.zeros(q.shape[0])
    for a in range(q.shape[1]):
        acc += survival_from_quantiles(q[:, a, :], u / np.maximum(sig[:, a], EPS))
    return np.clip(acc / q.shape[1], 0.0, 1.0)


def safe_level(pred: dict, alpha: float, up: bool = True,
               lo: float = 1e-5, hi: float = 2.0, iters: int = 36) -> np.ndarray:
    """Smallest log-distance `u` whose touch probability is <= alpha.

    This answers the user's question directly: *which level is strong enough
    that it will not break?* Bisection on a monotone curve, so it is exact to
    2^-36 of the bracket.
    """
    n = pred["sigma_atoms"].shape[0]
    a = np.full(n, lo)
    b = np.full(n, hi)
    for _ in range(iters):
        m = 0.5 * (a + b)
        risky = touch_prob(pred, m, up) > alpha
        a = np.where(risky, m, a)
        b = np.where(risky, b, m)
    return 0.5 * (a + b)


def prob_up(pred: dict) -> np.ndarray:
    """P(R > 0) -- the direction call, mixed over the volatility uncertainty."""
    q = pred["q_r"]
    zero = np.zeros(q.shape[0])
    acc = np.zeros(q.shape[0])
    for a in range(q.shape[1]):
        acc += survival_from_quantiles(q[:, a, :], zero)
    return np.clip(acc / q.shape[1], 0.0, 1.0)


def return_quantiles(pred: dict, levels: np.ndarray) -> np.ndarray:
    """Quantiles of the terminal log return R, mixed over sigma.

    Mixing quantiles requires going through the CDF, so we evaluate the mixed
    survival on a grid and invert it.
    """
    q = pred["q_r"]
    sig = pred["sigma_atoms"]
    n, A, _ = q.shape
    lo = (q[:, :, 0] * sig).min(axis=1)
    hi = (q[:, :, -1] * sig).max(axis=1)
    grid = np.linspace(lo, hi, 256).T                     # (n, G)

    surv = np.zeros_like(grid)
    for a in range(A):
        z = grid / np.maximum(sig[:, a], EPS)[:, None]
        for g in range(grid.shape[1]):
            surv[:, g] += survival_from_quantiles(q[:, a, :], z[:, g])
    surv /= A
    cdf = 1.0 - surv

    out = np.empty((n, len(levels)))
    for i in range(n):
        out[i] = np.interp(levels, cdf[i], grid[i])
    return out


def realized_vol_quantiles(pred: dict, levels: np.ndarray) -> np.ndarray:
    """Quantiles of RV over the window (total volatility, not a rate).

    Stage A predicts the log hourly rate, so the window total is
    exp(rate) * sqrt(H). exp() and sqrt() are monotone, so quantiles map
    straight through.
    """
    rate_q = quantiles_at(pred["qa"], levels)
    return np.exp(rate_q) * np.sqrt(pred["H"])[:, None]
