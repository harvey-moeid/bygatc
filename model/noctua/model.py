"""
noctua/model.py
=====================================================================
Stage 5: the NOCTUA model.

Two heads joined by a scale-invariance factorization (RESEARCH_PLAN section 4),
which section 2.4(ii) confirmed empirically: standardizing the barrier
functional by realized volatility collapses its spread across vol quintiles
from 4.4x to 1.23x.

    STAGE A   distribution of  y = log(RV) - 0.5*log(H)     (log hourly vol rate)
              = explicit Log-HAR linear base  +  gated residual MLP
              The base is INITIALISED AT THE OLS SOLUTION and the residual is
              zero-initialised, so training starts exactly at the Log-HAR
              benchmark and can only be judged by what it adds. If the residual
              learns nothing, we degrade gracefully to the bar rather than
              below it.

    STAGE B   distribution of the STANDARDIZED functionals, conditional on the
              true volatility scale sigma:
                    r        = R      / sigma
                    m_up     = M_up   / sigma        >= 0
                    m_dn     = -M_dn  / sigma        >= 0
              Monotone quantile functions, built as cumulative softplus
              increments so quantile crossing is impossible by construction.

    MIXING    P(M_up >= u) = E_sigma [ 1 - F_{m_up|sigma}( u / sigma ) ]
              evaluated by quadrature over Stage A's predictive quantiles.
              Deterministic, exact, ~microseconds -- no Monte-Carlo error,
              which is the specific failure mode of sampling a generative model
              (RESEARCH_PLAN section 2.2(a)).

Everything is trained with strictly proper scoring rules (pinball loss), plus
a pathwise-consistency penalty enforcing the constraints that hold on every
real price path.
"""
from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn

# The quantile grid and column layouts live in `spec`, which imports nothing
# but NumPy. Keeping them out of this module is what lets `noctua.infer` -- and
# through it the NumPy serving runtime -- avoid pulling PyTorch in transitively.
# Re-exported here so existing `from .model import BASE_COLS` imports still work.
from .spec import BASE_COLS, LEVELS, MEDIAN_IDX, SHAPE_COLS  # noqa: F401


# --------------------------------------------------------------------------
# building blocks
# --------------------------------------------------------------------------
class MonotoneQuantileHead(nn.Module):
    """Emit K quantiles that are monotone by construction.

    The median is free; every other level is reached by walking outward from it
    in strictly positive softplus steps. Quantile crossing -- the classic
    embarrassment of independently-parameterised quantile regression -- is
    therefore impossible rather than merely penalised.
    """

    def __init__(self, in_dim: int, n_levels: int, median_idx: int, nonneg: bool = False):
        super().__init__()
        self.n = n_levels
        self.mid = median_idx
        self.nonneg = nonneg
        self.n_up = n_levels - median_idx - 1
        self.n_dn = median_idx
        self.median = nn.Linear(in_dim, 1)
        self.up = nn.Linear(in_dim, self.n_up)
        self.dn = nn.Linear(in_dim, self.n_dn)

    def forward(self, h: torch.Tensor, offset: torch.Tensor | None = None) -> torch.Tensor:
        med = self.median(h)
        if offset is not None:
            med = med + offset
        steps_up = Fn.softplus(self.up(h)) + 1e-4
        steps_dn = Fn.softplus(self.dn(h)) + 1e-4
        q_up = med + torch.cumsum(steps_up, dim=1)
        q_dn = med - torch.flip(torch.cumsum(steps_dn, dim=1), dims=[1])
        q = torch.cat([q_dn, med, q_up], dim=1)
        if self.nonneg:
            q = Fn.softplus(q)  # keeps monotonicity (softplus is increasing)
        return q


class StageA(nn.Module):
    """Predictive distribution of the log hourly volatility rate.

    Output = Log-HAR linear base + monotone quantile residual.

    The base is a free linear term seeded at the OLS solution (see
    `init_base_from_ols`) and the residual head is seeded so its median offset
    is zero. Training therefore STARTS at the Log-HAR benchmark: the network
    can only be credited with what it adds on top, and if the residual is
    useless the model falls back to the bar rather than beneath it. This is the
    concrete implementation of RESEARCH_PLAN section 4.1.
    """

    def __init__(self, n_feat: int, n_base: int, hidden: int = 128):
        super().__init__()
        self.base = nn.Linear(n_base, 1)
        self.body = nn.Sequential(
            nn.Linear(n_feat, hidden), nn.GELU(),
            nn.Linear(hidden, hidden), nn.GELU(),
        )
        self.head = MonotoneQuantileHead(hidden, len(LEVELS), MEDIAN_IDX)
        self._init_residual()

    def _init_residual(self, init_spread: float = 0.12):
        """Start with a zero median offset and a narrow, sane quantile spread."""
        nn.init.zeros_(self.head.median.weight)
        nn.init.zeros_(self.head.median.bias)
        # softplus(b) = step  =>  b = log(exp(step) - 1)
        step = init_spread
        b = float(np.log(np.expm1(step)))
        for lin in (self.head.up, self.head.dn):
            nn.init.zeros_(lin.weight)
            nn.init.constant_(lin.bias, b)

    @torch.no_grad()
    def init_base_from_ols(self, beta: np.ndarray):
        """Seed the linear base with the fitted Log-HAR coefficients.

        `beta` is [intercept, coef_1, ..., coef_n] from the OLS baseline.
        """
        self.base.bias.copy_(torch.tensor([beta[0]], dtype=self.base.bias.dtype))
        self.base.weight.copy_(torch.tensor(beta[1:], dtype=self.base.weight.dtype).view(1, -1))

    def forward(self, x: torch.Tensor, xb: torch.Tensor, return_parts: bool = False):
        """Returns the quantile matrix, optionally with the residual location.

        `res_med` is how far the residual head has moved the MEDIAN away from
        the Log-HAR base. Penalising it (see `train.lam_anchor`) is what turns
        "degrades gracefully to Log-HAR" from an architectural intention into
        an enforced property: without it the residual is free to wander
        arbitrarily far from the benchmark, which is exactly what produced the
        2023 walk-forward blow-up (QLIKE +72% in a vol-collapse year).
        """
        h = self.body(x)
        q = self.head(h)
        out = self.base(xb) + q
        if return_parts:
            return out, self.head.median(h)
        return out


class StageB(nn.Module):
    """Distribution of the standardized functionals given the vol scale."""

    def __init__(self, n_shape: int, hidden: int = 128):
        super().__init__()
        self.body = nn.Sequential(
            nn.Linear(n_shape + 1, hidden), nn.GELU(),
            nn.Linear(hidden, hidden), nn.GELU(),
        )
        self.q_r = MonotoneQuantileHead(hidden, len(LEVELS), MEDIAN_IDX, nonneg=False)
        self.q_up = MonotoneQuantileHead(hidden, len(LEVELS), MEDIAN_IDX, nonneg=True)
        self.q_dn = MonotoneQuantileHead(hidden, len(LEVELS), MEDIAN_IDX, nonneg=True)

    def forward(self, xs: torch.Tensor, log_sigma: torch.Tensor):
        h = self.body(torch.cat([xs, log_sigma], dim=1))
        return self.q_r(h), self.q_up(h), self.q_dn(h)


class Noctua(nn.Module):
    def __init__(self, n_feat: int, n_base: int, n_shape: int, hidden: int = 128):
        super().__init__()
        self.a = StageA(n_feat, n_base, hidden)
        self.b = StageB(n_shape, hidden)

    def n_params(self) -> int:
        return sum(p.numel() for p in self.parameters())


# --------------------------------------------------------------------------
# losses
# --------------------------------------------------------------------------
def pinball_loss(q: torch.Tensor, y: torch.Tensor, levels: torch.Tensor,
                 w: torch.Tensor | None = None) -> torch.Tensor:
    """Mean pinball loss -- strictly proper for the quantile functional."""
    d = y[:, None] - q
    l = torch.maximum(levels[None, :] * d, (levels[None, :] - 1.0) * d).mean(dim=1)
    return (l * w).sum() / w.sum() if w is not None else l.mean()


def coupling_penalty(q_r: torch.Tensor, q_up: torch.Tensor, q_dn: torch.Tensor) -> torch.Tensor:
    """Enforce the identities that hold on every real path.

        m_up >= max(0,  r)        and        m_dn >= max(0, -r)

    Pointwise domination of random variables implies domination of their
    quantile functions, and max(0, .) commutes with quantiles because it is
    monotone. So the constraint on the MARGINALS we predict is exactly

        Q_up(tau) >= max(0,  Q_r(tau))
        Q_dn(tau) >= max(0, -Q_r(1 - tau))

    A model that can violate this is not describing a path at all. Enforcing it
    is free accuracy and a strong regulariser on the tails, which is where the
    seller's risk lives and where data is thinnest.
    """
    lo_up = torch.clamp(q_r, min=0.0)
    lo_dn = torch.clamp(-torch.flip(q_r, dims=[1]), min=0.0)
    return (Fn.relu(lo_up - q_up).mean() + Fn.relu(lo_dn - q_dn).mean())
