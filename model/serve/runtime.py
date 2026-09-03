"""
serve/runtime.py
=====================================================================
Dependency-free NOCTUA inference: NumPy + SciPy only, no PyTorch.

Why this exists: the trained network is 49,866 parameters. Shipping a ~2 GB
PyTorch install to evaluate it on a free 2 vCPU Space would be absurd, and the
cold start would dominate the latency. The forward pass is four matmuls and a
cumulative sum, so it is reimplemented here directly.

The genuinely delicate parts -- the monotone quantile construction, the
survival function with exponential tail extrapolation, and the mixing integral
over Stage A's volatility uncertainty -- are NOT reimplemented. They are
imported from `noctua.infer`, which was already pure NumPy, so the served
numbers are computed by exactly the same code the evaluation used.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.special import erf

DEFAULT_WEIGHTS = Path(__file__).with_name("noctua_weights.npz")


def gelu(x: np.ndarray) -> np.ndarray:
    """Exact GELU, matching torch.nn.GELU(approximate='none')."""
    return x * 0.5 * (1.0 + erf(x / np.sqrt(2.0)))


def softplus(x: np.ndarray) -> np.ndarray:
    # log1p(exp(x)) computed stably
    return np.logaddexp(0.0, x)


class NumpyNoctua:
    """NumPy re-implementation of the trained network plus its wrappers."""

    def __init__(self, path: Path | str = DEFAULT_WEIGHTS):
        z = np.load(path, allow_pickle=False)
        self.w = {k: z[k] for k in z.files if k != "meta_json"}
        self.meta = json.loads(bytes(z["meta_json"]).decode())
        self.levels = z["levels"]
        self.median_idx = int(np.argmin(np.abs(self.levels - 0.5)))

        self.feat_cols = self.meta["feat_cols"]
        self.base_cols = self.meta["base_cols"]
        self.shape_cols = self.meta["shape_cols"]
        self.blend_w = self.meta["blend_w"]
        self.cal_shrink = self.meta["cal_shrink"]

    # ---- primitives -------------------------------------------------------
    def _lin(self, prefix: str, x: np.ndarray) -> np.ndarray:
        return x @ self.w[f"{prefix}.weight"].T.astype(np.float64) + self.w[f"{prefix}.bias"].astype(np.float64)

    def _body(self, prefix: str, x: np.ndarray) -> np.ndarray:
        h = gelu(self._lin(f"{prefix}.0", x))
        return gelu(self._lin(f"{prefix}.2", h))

    def _qhead(self, prefix: str, h: np.ndarray, nonneg: bool) -> np.ndarray:
        """Mirror of MonotoneQuantileHead: median plus outward softplus steps."""
        med = self._lin(f"{prefix}.median", h)
        up = np.cumsum(softplus(self._lin(f"{prefix}.up", h)) + 1e-4, axis=1)
        dn = np.cumsum(softplus(self._lin(f"{prefix}.dn", h)) + 1e-4, axis=1)[:, ::-1]
        q = np.concatenate([med - dn, med, med + up], axis=1)
        return softplus(q) if nonneg else q

    # ---- stages -----------------------------------------------------------
    def stage_a(self, Xa: np.ndarray, Xb: np.ndarray) -> np.ndarray:
        return self._lin("a.base", Xb) + self._qhead("a.head", self._body("a.body", Xa), False)

    def stage_b(self, Xs: np.ndarray, log_sigma: np.ndarray):
        h = self._body("b.body", np.concatenate([Xs, log_sigma], axis=1))
        return (self._qhead("b.q_r", h, False),
                self._qhead("b.q_up", h, True),
                self._qhead("b.q_dn", h, True))

    # ---- standardization / feature assembly -------------------------------
    def _std(self, name: str, A: np.ndarray) -> np.ndarray:
        mu, sd = self.w[f"{name}_mu"], self.w[f"{name}_sd"]
        return np.nan_to_num((A - mu) / sd, nan=0.0, posinf=0.0, neginf=0.0)

    def prepare(self, features: "object", H: np.ndarray) -> dict:
        """`features` is a pandas DataFrame with at least `self.feat_cols`."""
        Xa = features[self.feat_cols].to_numpy(np.float64)
        Xb = features[self.base_cols].to_numpy(np.float64)
        Xs = features[self.shape_cols].to_numpy(np.float64)
        return {
            "Xa": self._std("std_all", Xa),
            "Xb": self._std("std_base", Xb),
            "Xs": self._std("std_shape", Xs),
            "H": np.asarray(H, dtype=np.float64),
        }

    def har_logvol(self, d: dict) -> np.ndarray:
        """The Log-HAR ensemble partner, from the stored OLS coefficients."""
        beta = self.w["har_beta"]
        return beta[0] + d["Xb"] @ beta[1:]

    # ---- full predictive object -------------------------------------------
    def predict(self, d: dict, n_atoms: int = 32) -> dict:
        from noctua import infer as I  # pure NumPy; same code the eval used

        qa = self.stage_a(d["Xa"], d["Xb"])
        har = self.har_logvol(d)
        if self.blend_w < 1.0:
            qa = qa + ((1.0 - self.blend_w) * (har - qa[:, self.median_idx]))[:, None]

        atom_levels = (np.arange(n_atoms) + 0.5) / n_atoms
        atoms_y = np.stack([np.interp(atom_levels, self.levels, row) for row in qa])
        H = d["H"]
        sigma_atoms = np.exp(atoms_y) * np.sqrt(H)[:, None]

        qr, qu, qd = [], [], []
        for i in range(n_atoms):
            ls = np.log(np.maximum(sigma_atoms[:, i], 1e-12))[:, None]
            r_, u_, d_ = self.stage_b(d["Xs"], ls)
            qr.append(r_); qu.append(u_); qd.append(d_)

        return {
            "qa": qa,
            "sigma_atoms": sigma_atoms,
            "sigma_med": np.exp(qa[:, self.median_idx]) * np.sqrt(H),
            "sigma_mean": np.sqrt(np.mean(np.exp(2.0 * atoms_y), axis=1) * H),
            "q_r": np.stack(qr, 1),
            "q_up": np.stack(qu, 1),
            "q_dn": np.stack(qd, 1),
            "H": H,
        }

    # ---- calibrated served quantities -------------------------------------
    def _cal_map(self, side: str) -> tuple[np.ndarray, np.ndarray] | None:
        gk, mk = f"cal_{side}_grid", f"cal_{side}_map"
        if gk not in self.w:
            return None
        g, m = self.w[gk], self.w[mk]
        eff = (1.0 - self.cal_shrink) * g + self.cal_shrink * m
        return g, eff

    def touch_prob(self, pred: dict, u: np.ndarray, up: bool = True) -> np.ndarray:
        from noctua import infer as I

        raw = I.touch_prob(pred, u, up=up)
        cm = self._cal_map("up" if up else "dn")
        if cm is None:
            return raw
        g, eff = cm
        return np.clip(1.0 - np.interp(np.clip(1.0 - raw, 0, 1), g, eff), 0.0, 1.0)

    def safe_level(self, pred: dict, alpha: float, up: bool = True, iters: int = 36) -> np.ndarray:
        n = pred["sigma_atoms"].shape[0]
        lo, hi = np.full(n, 1e-5), np.full(n, 2.0)
        for _ in range(iters):
            m = 0.5 * (lo + hi)
            risky = self.touch_prob(pred, m, up) > alpha
            lo = np.where(risky, m, lo)
            hi = np.where(risky, hi, m)
        return 0.5 * (lo + hi)

    def prob_up(self, pred: dict) -> np.ndarray:
        from noctua import infer as I

        return I.prob_up(pred)


# ==========================================================================
# NOCTUA v2: seed ensemble + equal-weight specialist committee
# ==========================================================================
# Shipping shape, all of it measured (see model/RESULTS_V2.md):
#   * width 32, not 128 -- the capacity sweep is monotone the "wrong" way
#   * 3 seeds averaged  -- free variance reduction
#   * 4 specialists, EQUAL weights, pooled by Vincentization
#
# Equal weights are a result, not laziness. Level-dependent fitted weights and
# a state-conditioned gating network were both built and evaluated; both
# converged to uniform-or-degenerate and neither beat the plain average.
class NoctuaV2(NumpyNoctua):
    """Committee inference. NumPy + SciPy only, same as v1."""

    def __init__(self, path: Path | str | None = None):
        p = Path(path) if path else Path(__file__).with_name("noctua_v2.npz")
        z = np.load(p, allow_pickle=False)
        self.w = {k: z[k] for k in z.files if k != "meta_json"}
        self.meta = json.loads(bytes(z["meta_json"]).decode())
        self.levels = z["levels"]
        self.alpha_grid = z["alpha_grid"]
        self.q_levels = 1.0 - self.alpha_grid
        self.median_idx = int(np.argmin(np.abs(self.levels - 0.5)))

        self.feat_cols = self.meta["feat_cols"]
        self.base_cols = self.meta["base_cols"]
        self.shape_cols = self.meta["shape_cols"]
        self.blend_w = self.meta["blend_w"]
        self.n_seeds = self.meta["seeds"]
        self.cal_shrink = 0.0            # v2 pools instead of PIT-recalibrating

    # ---- per-seed weight access ------------------------------------------
    def _seed_scope(self, src: dict, s: int) -> dict:
        """Extract one seed's weights from `src`.

        Takes the source dict explicitly rather than reading self.w: predict()
        swaps self.w per seed, so scoping off self.w silently returned an empty
        dict from the second seed onward.
        """
        pre = f"m{s}."
        return {k[len(pre):]: v for k, v in src.items() if k.startswith(pre)}

    def predict(self, d: dict, n_atoms: int = 32) -> dict:
        """Average the seed ensemble's predictive objects."""
        outs = []
        full = self.w
        try:
            for s in range(self.n_seeds):
                self.w = {**self._seed_scope(full, s), "har_beta": full["har_beta"]}
                outs.append(NumpyNoctua.predict(self, d, n_atoms=n_atoms))
        finally:
            self.w = full
        avg = dict(outs[0])
        for k in ("qa", "sigma_atoms", "sigma_med", "sigma_mean", "q_r", "q_up", "q_dn"):
            avg[k] = np.mean([o[k] for o in outs], axis=0)
        return avg

    # ---- specialists -------------------------------------------------------
    def _mix_over_sigma(self, z: np.ndarray, sigma_atoms: np.ndarray,
                        n_grid: int = 400) -> np.ndarray:
        """Integrate a standardized quantile curve over sigma uncertainty.

        Without this the analytic specialists are under-dispersed relative to
        the neural one, which pulls every pooled level too close to spot. It
        was the single defect standing between a committee that lost and one
        that wins (3.199 -> 2.455 pp).
        """
        n, A = sigma_atoms.shape
        lo = float(z[-1]) * np.maximum(sigma_atoms.min(axis=1), 1e-12)
        hi = float(z[0]) * np.maximum(sigma_atoms.max(axis=1), 1e-12) * 1.5
        grid = np.linspace(lo, hi, n_grid).T
        z_asc, lev_asc = z[::-1], self.q_levels[::-1]
        cdf = np.zeros_like(grid)
        for a in range(A):
            cdf += np.interp(grid / np.maximum(sigma_atoms[:, a], 1e-12)[:, None],
                             z_asc, lev_asc, left=0.0, right=1.0)
        cdf /= A
        return np.stack([np.interp(self.q_levels, cdf[i], grid[i]) for i in range(n)])

    def _evt_z(self, side: str) -> np.ndarray:
        u, xi, beta, tq = self.w[f"evt_{side}"]
        emp = self.w[f"evt_{side}_emp"]
        out = np.empty(len(self.q_levels))
        for j, q in enumerate(self.q_levels):
            if q <= tq:
                out[j] = emp[j]
            else:
                frac = (1.0 - q) / (1.0 - tq)
                out[j] = (u + beta * (-np.log(frac)) if abs(xi) < 1e-6
                          else u + (beta / xi) * (frac ** (-xi) - 1.0))
        return np.minimum.accumulate(out)      # q_levels descend, so must this

    def committee_quantiles(self, pred: dict, up: bool = True) -> np.ndarray:
        """Equal-weight Vincentization of the four specialist quantile curves.

        Memoised on `pred`. The pooled curve depends only on `pred` and `up`,
        but `forecast()` asks for 18 touch probabilities and 10 safe levels,
        and each rebuild runs eight bisections over 32 sigma atoms for the
        neural member alone. Rebuilding per query cost ~250k redundant
        survival evaluations per one-row forecast.
        """
        from noctua import infer as I

        key = "_pooled_up" if up else "_pooled_dn"
        if key in pred:
            return pred[key]

        atoms = pred["sigma_atoms"]
        neural = np.stack([I.safe_level(pred, float(a), up=up) for a in self.alpha_grid],
                          axis=1)
        gauss = self._mix_over_sigma(-norm_ppf(self.alpha_grid / 2.0), atoms)
        emp = self._mix_over_sigma(self.w["emp_z_up" if up else "emp_z_dn"], atoms)
        evt = self._mix_over_sigma(self._evt_z("up" if up else "dn"), atoms)

        pooled = 0.25 * (neural + gauss + emp + evt)
        pooled = np.maximum.accumulate(pooled[:, ::-1], axis=1)[:, ::-1]
        pred[key] = pooled
        return pooled

    # ---- tails outside the pooled grid -------------------------------------
    # ALPHA_GRID spans [0.005, 0.5], so the pooled curve only speaks about
    # barriers between the median excursion and the 99.5th percentile. Reading
    # it with a flat clamp outside that span reports every near barrier as
    # exactly 0.50 and every far barrier as exactly 0.00 -- i.e. it tells an
    # option seller that a 10% move is impossible. Both ends are extrapolated
    # instead, with the two closed forms that the endpoints already imply.
    _Z25 = 0.6744897501960817          # -Phi^-1(0.25)

    def _near_sigma(self, q_med: np.ndarray) -> np.ndarray:
        """Scale of the reflection-principle survival that passes through the
        pooled median level: P(M >= u) = 2*Phi(-u/s), so P = 0.5 at u = q_med
        requires s = q_med / -Phi^-1(0.25). Tends to 1 as u -> 0, as a touch
        probability must."""
        return np.maximum(q_med, 1e-12) / self._Z25

    def _far_k(self, Qp: np.ndarray) -> np.ndarray:
        """Power-law exponent implied by the two deepest pooled quantiles:
        alpha(u) = a0 * (u/u0)^-k. Fitted from the curve rather than from the
        EVT member's raw xi, because the pooled tail is a scale MIXTURE over
        the 32 sigma atoms and so is fatter than any single standardized GPD
        (both fitted xi are negative, i.e. bounded, before mixing)."""
        u0, u1 = np.maximum(Qp[:, 0], 1e-12), np.maximum(Qp[:, 1], 1e-12)
        a0, a1 = self.alpha_grid[0], self.alpha_grid[1]
        ratio = np.maximum(u0 / u1, 1.0 + 1e-9)
        return np.log(a1 / a0) / np.log(ratio)

    def safe_level(self, pred: dict, alpha: float, up: bool = True, **_) -> np.ndarray:
        Qp = self.committee_quantiles(pred, up)
        a_lo, a_hi = float(self.alpha_grid[0]), float(self.alpha_grid[-1])

        if alpha > a_hi:                       # nearer than the median excursion
            return -self._near_sigma(Qp[:, -1]) * norm_ppf(min(alpha, 1.0) / 2.0)
        if alpha < a_lo:                       # deeper than the 99.5th percentile
            k = self._far_k(Qp)
            return Qp[:, 0] * (alpha / a_lo) ** (-1.0 / k)

        j = int(np.argmin(np.abs(self.alpha_grid - alpha)))
        if abs(self.alpha_grid[j] - alpha) < 1e-9:
            return Qp[:, j]
        return np.array([np.interp(1.0 - alpha, self.q_levels[::-1], r[::-1]) for r in Qp])

    def touch_prob(self, pred: dict, u: np.ndarray, up: bool = True) -> np.ndarray:
        """Invert the pooled quantile curve to a touch probability."""
        Qp = self.committee_quantiles(pred, up)
        u = np.abs(np.asarray(u, dtype=np.float64))
        if u.ndim == 0:
            u = np.full(Qp.shape[0], float(u))

        s_near = self._near_sigma(Qp[:, -1])
        k_far = self._far_k(Qp)
        a_lo, a_hi = float(self.alpha_grid[0]), float(self.alpha_grid[-1])

        out = np.empty(Qp.shape[0])
        for i in range(Qp.shape[0]):
            if u[i] <= Qp[i, -1]:
                out[i] = 2.0 * norm_cdf(-u[i] / s_near[i])
            elif u[i] >= Qp[i, 0]:
                out[i] = a_lo * (max(u[i], 1e-12) / Qp[i, 0]) ** (-k_far[i])
            else:
                out[i] = np.interp(u[i], Qp[i, ::-1], self.alpha_grid[::-1],
                                   left=a_hi, right=a_lo)
        return np.clip(out, 0.0, 1.0)


def norm_ppf(p):
    from scipy.stats import norm as _n
    return _n.ppf(p)


def norm_cdf(x):
    from scipy.stats import norm as _n
    return _n.cdf(x)


# ==========================================================================
# artifact selection
# ==========================================================================
V2_NAME = "noctua_v2.npz"
V1_NAME = "noctua_weights.npz"


def _artifact_version(path: Path) -> str:
    """Read the artifact's own version tag.

    Dispatching on the FILENAME was the earlier approach and it is wrong in
    both directions: a v2 artifact downloaded under another name would be
    loaded by the v1 runtime, which expects a flat weight layout and would
    fail mid-forecast, and a v1 file whose name happened to contain "v2"
    would fail the opposite way. The npz already carries the answer.
    """
    with np.load(path, allow_pickle=False) as z:
        if "meta_json" not in z.files:
            return "NOCTUA-v1"          # earliest artifacts predate meta_json
        return json.loads(bytes(z["meta_json"]).decode()).get("version", "NOCTUA-v1")


def load_model(path: Path | str | None = None):
    """Load whichever artifact is present, newest first.

    Shared by `serve.predict` (the GitHub Action) and `serve.app` (the Hugging
    Face Space) so the two cannot drift onto different models -- the Space
    served v1 for as long as it constructed `NumpyNoctua` directly.
    """
    here = Path(__file__).parent
    if path is None:
        path = here / V2_NAME if (here / V2_NAME).exists() else here / V1_NAME
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"no NOCTUA artifact at {path}")
    return NoctuaV2(path) if _artifact_version(path) == "NOCTUA-v2" else NumpyNoctua(path)
