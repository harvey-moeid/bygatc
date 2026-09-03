"""
eval/benchmark.py
=====================================================================
NOCTUA-BENCH: an adversarial benchmark for overnight barrier forecasting.

Built because the metric this project had been quoting is CHEATABLE.

"Mean |coverage error|" -- the 1.629 pp headline -- rewards a forecaster whose
barrier levels are breached alpha% of the time. A model that ignores every
input and emits the unconditional historical quantiles of the excursion
achieves that essentially perfectly, because marginal coverage is exactly what
an unconditional distribution is fitted to. It has zero skill and would post a
near-perfect score. Any benchmark a constant can win is not measuring skill,
it is measuring whether you remembered to fit an intercept.

So every number here obeys two rules.

RULE 1 -- every score is STRICTLY PROPER, or it is a falsification test.
  A strictly proper scoring rule is uniquely minimised by the true predictive
  distribution, so it cannot be improved by any misrepresentation. Calibration
  alone cannot win one: proper scores charge jointly for calibration AND
  sharpness. Brier, log score, pinball and CRPS are all strictly proper.
  Marginal coverage error is NOT, and is reported here only under a banner
  saying so.

RULE 2 -- every score is accompanied by a baseline that would BEAT a
  cheatable metric.
  `climatology` is the adversary: a constant, input-blind forecaster. If it
  wins a metric, that metric is broken. It is in every table on purpose.

The decisive quantity is DISCRIMINATION (DSC) from the CORP decomposition
(Dimitriadis, Gneiting & Jordan, PNAS 2021). Decomposing a proper score as

    S  =  MCB  -  DSC  +  UNC
          (miscalibration)  (discrimination)  (intrinsic uncertainty)

where the calibrated forecast is obtained by isotonic regression of the
outcome on the forecast (bin-free, no arbitrary histogram). DSC measures how
much the forecast MOVES with the outcome. For any constant forecaster the
isotonic fit is the base rate everywhere, so

    DSC == 0, exactly and by construction.

DSC cannot be faked, cannot be tuned, and cannot be reached by a model that
has not learned something conditional about the state of the market. It is the
single number that answers "is this model actually thinking, or is it a
lookup table with good manners?"

Usage:
    python -m model.eval.benchmark --folds all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import chi2, norm
from sklearn.isotonic import IsotonicRegression

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua import baselines as B                                    # noqa: E402
from noctua import infer as I                                        # noqa: E402
from noctua import splits as S                                       # noqa: E402
from noctua.committee import (ALPHA_GRID, Committee, EmpiricalSpecialist,  # noqa: E402
                              EVTSpecialist, GaussianSpecialist,
                              NeuralSpecialist)
from noctua.model import BASE_COLS                                   # noqa: E402
from noctua.train import load_all, prepare, train_model              # noqa: E402

# Barrier events every forecaster is scored on. Fixed in percent, identical
# across models, so the scores compare like with like: each is a genuine
# binary event ("was this level touched before settlement?") with an
# unambiguous outcome.
BARRIER_PCT = np.array([0.5, 1.0, 2.0, 3.0, 5.0])
BARRIER_U = np.log1p(BARRIER_PCT / 100.0)

Q_LEVELS_DESC = 1.0 - ALPHA_GRID          # descending, matches ALPHA_GRID order


# ==========================================================================
# scoring rules
# ==========================================================================
def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def log_score(p: np.ndarray, y: np.ndarray, eps: float = 1e-6) -> float:
    p = np.clip(p, eps, 1 - eps)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def corp_decomposition(p: np.ndarray, y: np.ndarray) -> dict:
    """CORP reliability-resolution decomposition of the Brier score.

    Dimitriadis, Gneiting & Jordan (2021), "Stable reliability diagrams for
    probabilistic classifiers", PNAS 118(8). The calibrated forecast is the
    isotonic (PAV) regression of the outcome on the forecast -- the
    nonparametric, bin-free recalibration -- which makes the decomposition
    free of the arbitrary binning choices that plague Murphy's original.

        S = MCB - DSC + UNC

    DSC is the quantity that cannot be gamed. It is the improvement of the
    recalibrated forecast over the climatological base rate. A forecast that
    is constant across episodes recalibrates to the base rate exactly, giving
    DSC = 0 no matter how well calibrated it is. Skill shows up here or it
    does not exist.
    """
    p = np.asarray(p, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    base = float(np.mean(y))

    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    p_cal = iso.fit_transform(p, y)

    s_raw = brier(p, y)
    s_cal = brier(p_cal, y)
    s_ref = brier(np.full_like(y, base), y)
    return {
        "brier": s_raw,
        "MCB": s_raw - s_cal,          # miscalibration: lower is better
        "DSC": s_ref - s_cal,          # discrimination: HIGHER is better, 0 = no skill
        "UNC": s_ref,
        "base_rate": base,
    }


def pinball_curve(Q: np.ndarray, y: np.ndarray) -> float:
    """Mean pinball loss of a quantile CURVE. Strictly proper for quantiles.

    `Q` is (n, J) at levels Q_LEVELS_DESC, `y` the realized excursion.
    """
    tot = 0.0
    for j, tau in enumerate(Q_LEVELS_DESC):
        d = y - Q[:, j]
        tot += float(np.mean(np.maximum(tau * d, (tau - 1.0) * d)))
    return tot / len(Q_LEVELS_DESC)


def crps_from_curve(Q: np.ndarray, y: np.ndarray) -> float:
    """CRPS approximated from the quantile curve.

    CRPS(F, y) = 2 * integral_0^1 QL_tau(F^-1(tau), y) dtau, so a
    trapezoidal integral of the pinball loss over the level grid is a
    consistent estimate. Strictly proper for the full predictive
    distribution -- it charges for sharpness as well as calibration.
    """
    order = np.argsort(Q_LEVELS_DESC)
    taus = Q_LEVELS_DESC[order]
    losses = []
    for j in order:
        tau = Q_LEVELS_DESC[j]
        d = y - Q[:, j]
        losses.append(float(np.mean(np.maximum(tau * d, (tau - 1.0) * d))))
    return float(2.0 * np.trapezoid(losses, taus))


# ==========================================================================
# conditional-calibration tests
# ==========================================================================
def christoffersen(exceed: np.ndarray, alpha: float) -> dict:
    """Christoffersen (1998) coverage tests on a barrier-breach sequence.

    Marginal coverage says the breaches happen at the right RATE.
    Independence says they do not CLUSTER. A model that merely learned the
    unconditional excursion distribution passes the first and fails the
    second, because in a volatile week every level breaks and in a calm week
    none do. This is the cheapest honest test of whether a forecast is
    conditional.

    LR_uc  ~ chi2(1)  unconditional coverage
    LR_ind ~ chi2(1)  independence of consecutive breaches
    LR_cc  ~ chi2(2)  both jointly
    """
    e = np.asarray(exceed, dtype=int)
    n, n1 = len(e), int(e.sum())
    n0 = n - n1
    pi = n1 / max(n, 1)

    def _ll(p, k, m):
        p = min(max(p, 1e-12), 1 - 1e-12)
        return k * np.log(p) + m * np.log(1 - p)

    lr_uc = -2.0 * (_ll(alpha, n1, n0) - _ll(pi, n1, n0))

    # transition counts n_ij = from state i to state j
    prev, cur = e[:-1], e[1:]
    n00 = int(((prev == 0) & (cur == 0)).sum())
    n01 = int(((prev == 0) & (cur == 1)).sum())
    n10 = int(((prev == 1) & (cur == 0)).sum())
    n11 = int(((prev == 1) & (cur == 1)).sum())
    pi01 = n01 / max(n00 + n01, 1)
    pi11 = n11 / max(n10 + n11, 1)
    pi_all = (n01 + n11) / max(n00 + n01 + n10 + n11, 1)

    ll_ind = _ll(pi01, n01, n00) + _ll(pi11, n11, n10)
    ll_pool = _ll(pi_all, n01 + n11, n00 + n10)
    lr_ind = -2.0 * (ll_pool - ll_ind)

    return {
        "hit_rate": pi, "alpha": alpha,
        "LR_uc": float(lr_uc), "p_uc": float(1 - chi2.cdf(lr_uc, 1)),
        "LR_ind": float(lr_ind), "p_ind": float(1 - chi2.cdf(lr_ind, 1)),
        "LR_cc": float(lr_uc + lr_ind), "p_cc": float(1 - chi2.cdf(lr_uc + lr_ind, 2)),
    }


# ==========================================================================
# the competitors
# ==========================================================================
class Forecaster:
    """Each competitor emits a barrier quantile curve per episode, per side.

    Everything else -- touch probabilities on the fixed barrier grid, pinball,
    CRPS -- is derived from that one object, so no competitor gets a
    structurally different treatment.
    """

    name = "base"

    def curve(self, ctx: dict, up: bool) -> np.ndarray:
        raise NotImplementedError

    def touch(self, ctx: dict, u: np.ndarray, up: bool) -> np.ndarray:
        """P(touch) at each barrier in `u`, inverted from the quantile curve."""
        Q = self.curve(ctx, up)
        out = np.empty((Q.shape[0], len(u)))
        for i in range(Q.shape[0]):
            out[i] = np.interp(u, Q[i, ::-1], ALPHA_GRID[::-1],
                               left=float(ALPHA_GRID[-1]), right=float(ALPHA_GRID[0]))
        return np.clip(out, 1e-6, 1 - 1e-6)


class NoctuaCommittee(Forecaster):
    """The shipped model: 3-seed width-32 net + equal-weight specialist committee."""

    name = "noctua_v2"

    def __init__(self, committee):
        self.c = committee

    def curve(self, ctx, up):
        return self.c.quantiles(ctx["sigma"], ctx["pred"], up=up)


class ShuffledNoctua(NoctuaCommittee):
    """NOCTUA reading a RANDOM OTHER episode's features.

    The single most informative control in this file. It keeps the model, the
    training, the committee and the marginal distribution of forecasts
    completely intact, and destroys only the ALIGNMENT between the forecast
    and the episode it is scored against. Any skill that survives this is not
    skill -- it is an artifact of the marginal distribution.

    Proper scores must collapse toward climatology here. If they do not, the
    benchmark is measuring the wrong thing.
    """

    name = "noctua_shuffled"

    def __init__(self, committee, seed=0):
        super().__init__(committee)
        self.seed = seed

    def curve(self, ctx, up):
        Q = self.c.quantiles(ctx["sigma"], ctx["pred"], up=up)
        rng = np.random.default_rng(self.seed)
        return Q[rng.permutation(Q.shape[0])]


class GaussianFirstPassage(Forecaster):
    """Reflection-principle barrier law driven by some volatility forecast.

    Covers the classical answer to this problem: predict sigma, then price the
    barrier analytically. Two variants below differ ONLY in where sigma comes
    from, which isolates the value of the volatility model from the value of
    the barrier model.
    """

    def __init__(self, name, sigma_key):
        self.name = name
        self.sigma_key = sigma_key

    def curve(self, ctx, up):
        sig = np.maximum(ctx[self.sigma_key], 1e-12)[:, None]
        return sig * (-norm.ppf(ALPHA_GRID / 2.0))[None, :]


class Climatology(Forecaster):
    """THE ADVERSARY. Constant, input-blind, fitted on the training split only.

    Emits the same unconditional excursion quantiles for every episode in
    history. It knows nothing about today. Its marginal coverage is excellent
    by construction, so it beats any calibration-only metric.

    Its discrimination is exactly zero. That is the point.
    """

    name = "climatology"

    def __init__(self, m_up_train, m_dn_train):
        self.q_up = np.quantile(np.abs(m_up_train), Q_LEVELS_DESC)
        self.q_dn = np.quantile(np.abs(m_dn_train), Q_LEVELS_DESC)

    def curve(self, ctx, up):
        q = self.q_up if up else self.q_dn
        return np.tile(q, (ctx["n"], 1))


class ScaledClimatology(Forecaster):
    """Unconditional SHAPE, rescaled by trailing realized vol.

    A genuinely strong naive competitor and the fairest "no model" reference:
    it concedes that volatility clusters (which is free) while conceding
    nothing about the shape of the excursion distribution. Beating this is
    the minimum bar for the neural machinery to have earned its place.
    """

    name = "scaled_clim"

    def __init__(self, m_up_train, m_dn_train, sigma_train):
        s = np.maximum(sigma_train, 1e-12)
        self.z_up = np.quantile(np.abs(m_up_train) / s, Q_LEVELS_DESC)
        self.z_dn = np.quantile(np.abs(m_dn_train) / s, Q_LEVELS_DESC)

    def curve(self, ctx, up):
        z = self.z_up if up else self.z_dn
        return np.maximum(ctx["sigma_trail"], 1e-12)[:, None] * z[None, :]


# ==========================================================================
# one walk-forward fold
# ==========================================================================
def run_fold(ep, X, fold, hidden=32, seeds=3, verbose=False, shape_cols=None,
             sigma_ref_all=None, sigma_ref_fn=None, extra_w=None,
             train_filter=None, min_train=5000, prod_override=None):
    fin = np.isfinite(X.to_numpy()).all(1)
    # `prod_override` lets a caller score a DIFFERENT slice (e.g. one
    # horizon at a time) through this same path, so its numbers stay
    # comparable to the headline: same committee, both sides, same
    # barriers. Reimplementing the scoring elsewhere is how a
    # 'decomposition' quietly ends up measuring a different estimator.
    prod = (S.production_mask(ep) if prod_override is None
            else np.asarray(prod_override, bool))
    m_tr, m_va = fold["train"] & fin, fold["calib"] & fin
    if train_filter is not None:
        m_tr = m_tr & train_filter
    m_te = fold["test"] & fin & prod
    if m_tr.sum() < min_train or m_te.sum() < 30 or m_va.sum() < 500:
        return None

    # `sigma_ref_all` retargets stage B onto a CAUSAL volatility forecast
    # instead of the realized RV. It applies to train and calib only: at
    # prediction time infer.predict conditions on its own sigma_atoms and
    # ignores d["log_sigma"] entirely, so the test slice needs no counterpart.
    # A CALLABLE is the causal form: its clip bounds are refitted on THIS
    # fold's training episodes, so nothing downstream of the fold boundary can
    # influence the reference. The array form is kept only for diagnostics.
    if sigma_ref_fn is not None:
        sigma_ref_all = sigma_ref_fn(m_tr)
    sr_tr = None if sigma_ref_all is None else np.asarray(sigma_ref_all)[m_tr]
    sr_va = None if sigma_ref_all is None else np.asarray(sigma_ref_all)[m_va]
    tr, stds = prepare(ep, X, m_tr, shape_cols=shape_cols, sigma_ref=sr_tr)
    wtr = S.sample_weights(ep, m_tr)
    if extra_w is not None:
        wtr = wtr * np.asarray(extra_w)[m_tr]
        wtr = wtr / max(wtr.mean(), 1e-12)
    va, _ = prepare(ep, X, m_va, *stds, shape_cols=shape_cols, sigma_ref=sr_va)
    H = ep.H.to_numpy(np.float64)
    yall = B.har_target(ep.RV.to_numpy(), H)

    ols = B.OLS(BASE_COLS).fit(pd.DataFrame(tr["Xb"], columns=BASE_COLS),
                               tr["y"].astype(np.float64), wtr)
    bl = B.fit_vol_baselines(X[m_tr], yall[m_tr], wtr)
    models = [train_model(tr, wtr, va, hidden=hidden, epochs=40, seed=s,
                          verbose=verbose, ols_beta=ols.beta)[0] for s in range(seeds)]

    def predict_avg(mask):
        d, _ = prepare(ep, X, mask, *stds, shape_cols=shape_cols)
        lp = bl["log_har_cal"].predict(X[mask])
        preds = [I.predict(m, d, har_logvol=lp) for m in models]
        out = dict(preds[0])
        for k in ("qa", "sigma_atoms", "sigma_med", "q_r", "q_up", "q_dn"):
            out[k] = np.mean([p[k] for p in preds], axis=0)
        return out, lp

    # ---- calibration slice: fit the committee (equal weights, as shipped) --
    m_cal = m_va & (ep.H == 19).to_numpy()
    p_cal, lp_cal = predict_avg(m_cal)
    e_cal = ep[m_cal]
    sig_cal = np.exp(lp_cal) * np.sqrt(H[m_cal])
    specs = [
        NeuralSpecialist(),
        GaussianSpecialist().fit(e_cal.M_up.to_numpy(), e_cal.M_dn.to_numpy(), sig_cal),
        EmpiricalSpecialist().fit(ep.M_up.to_numpy()[m_tr], ep.M_dn.to_numpy()[m_tr],
                                  ep.RV.to_numpy()[m_tr]),
        EVTSpecialist().fit(ep.M_up.to_numpy()[m_tr], ep.M_dn.to_numpy()[m_tr],
                            ep.RV.to_numpy()[m_tr]),
    ]
    comm = Committee(specs).fit_equal()

    # ---- test slice --------------------------------------------------------
    p_te, lp_te = predict_avg(m_te)
    e_te = ep[m_te]
    Ht = H[m_te]
    sig_model = np.exp(lp_te) * np.sqrt(Ht)

    # Trailing realized vol, the naive sigma. Taken from the FEATURE har_1d
    # (log hourly vol over the trailing day), NOT from episodes.RV1 -- RV1 is
    # built from fwd_rv1, i.e. it looks FORWARD from the anchor and correlates
    # 0.953 with the target. Using it here would have handed the persistence
    # baseline a look-ahead advantage and quietly invalidated every comparison
    # in this file.
    sig_persist = np.maximum(np.exp(X.loc[m_te, "har_1d"].to_numpy()) * np.sqrt(Ht), 1e-12)

    ctx = {
        "n": int(m_te.sum()), "pred": p_te,
        "sigma": sig_model, "sigma_trail": sig_persist, "sigma_persist": sig_persist,
        "sigma_model": sig_model,
    }

    tr_up = np.abs(ep.M_up.to_numpy()[m_tr])
    tr_dn = np.abs(ep.M_dn.to_numpy()[m_tr])
    sig_tr = np.exp(bl["log_har_cal"].predict(X[m_tr])) * np.sqrt(H[m_tr])

    competitors = [
        NoctuaCommittee(comm),
        GaussianFirstPassage("log_har_gauss", "sigma_model"),
        GaussianFirstPassage("persistence", "sigma_persist"),
        ScaledClimatology(tr_up, tr_dn, sig_tr),
        Climatology(tr_up, tr_dn),
        ShuffledNoctua(comm, seed=fold["year"]),
    ]

    M = {"up": np.abs(e_te.M_up.to_numpy()), "dn": np.abs(e_te.M_dn.to_numpy())}
    rows = []
    for f in competitors:
        rec = {"model": f.name, "year": fold["year"], "n": ctx["n"]}
        for side in ("up", "dn"):
            up = side == "up"
            Q = f.curve(ctx, up)
            y = M[side]
            rec[f"pinball_{side}"] = pinball_curve(Q, y)
            rec[f"crps_{side}"] = crps_from_curve(Q, y)
            P = f.touch(ctx, BARRIER_U, up)
            for k, pct in enumerate(BARRIER_PCT):
                out = (y >= BARRIER_U[k]).astype(float)
                d = corp_decomposition(P[:, k], out)
                rec[f"brier_{side}_{pct}"] = d["brier"]
                rec[f"DSC_{side}_{pct}"] = d["DSC"]
                rec[f"MCB_{side}_{pct}"] = d["MCB"]
                rec[f"UNC_{side}_{pct}"] = d["UNC"]
                rec[f"logs_{side}_{pct}"] = log_score(P[:, k], out)
            # marginal coverage error -- the CHEATABLE metric, kept for contrast
            cov = []
            for a in (0.01, 0.02, 0.05, 0.10):
                j = int(np.argmin(np.abs(ALPHA_GRID - a)))
                cov.append(abs((y >= Q[:, j]).mean() - a))
            rec[f"coverage_err_{side}"] = 100 * float(np.mean(cov))
        rows.append(rec)

    # volatility QLIKE, for continuity with the earlier reports
    rv = e_te.RV.to_numpy()

    def ql(sig):
        pv = np.maximum(sig, 1e-12) ** 2
        r = np.maximum(rv ** 2, 1e-18) / np.maximum(pv, 1e-18)
        return float(np.mean(r - np.log(r) - 1.0))

    vol = {"noctua": ql(p_te["sigma_med"]), "log_har": ql(sig_model),
           "persistence": ql(sig_persist)}

    # Christoffersen on the shipped model's own alpha=5% level
    j5 = int(np.argmin(np.abs(ALPHA_GRID - 0.05)))
    chr_ = {}
    for side in ("up", "dn"):
        Q = comm.quantiles(ctx["sigma"], p_te, up=(side == "up"))
        chr_[side] = christoffersen((M[side] >= Q[:, j5]).astype(int), 0.05)

    return {"rows": rows, "vol": vol, "christoffersen": chr_, "year": fold["year"]}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="NOCTUA-BENCH")
    p.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    p.add_argument("--hidden", type=int, default=32)
    p.add_argument("--seeds", type=int, default=3)
    p.add_argument("--out", type=Path, default=Path("model/artifacts/benchmark.json"))
    a = p.parse_args(argv)

    ep, X = load_all(a.artifacts)
    folds = S.walk_forward_folds(ep)
    print(f"[bench] {len(folds)} walk-forward folds, hidden={a.hidden}, seeds={a.seeds}\n")

    res = []
    for f in folds:
        r = run_fold(ep, X, f, a.hidden, a.seeds)
        if r is None:
            continue
        print(f"  fold {r['year']} done  (n={r['rows'][0]['n']})")
        res.append(r)

    df = pd.DataFrame([row for r in res for row in r["rows"]])
    agg = df.groupby("model").mean(numeric_only=True)

    order = ["noctua_v2", "log_har_gauss", "persistence", "scaled_clim",
             "climatology", "noctua_shuffled"]
    agg = agg.reindex([o for o in order if o in agg.index])

    def col(pat):
        cs = [c for c in agg.columns if c.startswith(pat)]
        return agg[cs].mean(axis=1)

    print("\n" + "=" * 78)
    print("TIER 1 -- STRICTLY PROPER SCORES  (lower is better; cannot be gamed)")
    print("=" * 78)
    t1 = pd.DataFrame({
        "pinball": col("pinball_"), "CRPS": col("crps_"),
        "brier": col("brier_"), "log_score": col("logs_"),
    })
    print(t1.round(6).to_string())

    print("\n" + "=" * 78)
    print("TIER 2 -- CORP DECOMPOSITION  (DSC is the uncheatable one; 0 = no skill)")
    print("=" * 78)
    t2 = pd.DataFrame({"DSC (higher=better)": col("DSC_"),
                       "MCB (lower=better)": col("MCB_"),
                       "UNC": col("UNC_")})
    print(t2.round(6).to_string())

    print("\n" + "=" * 78)
    print("THE CHEATABLE METRIC, FOR CONTRAST -- mean |coverage error|, pp")
    print("=" * 78)
    print(col("coverage_err_").round(3).to_string())

    print("\n=== VOLATILITY QLIKE ===")
    for k in ("noctua", "log_har", "persistence"):
        print(f"  {k:<12} {np.mean([r['vol'][k] for r in res]):.4f}")

    print("\n=== CHRISTOFFERSEN, alpha=5% level (conditional coverage) ===")
    for side in ("up", "dn"):
        hr = np.mean([r["christoffersen"][side]["hit_rate"] for r in res])
        pu = np.mean([r["christoffersen"][side]["p_uc"] for r in res])
        pi_ = np.mean([r["christoffersen"][side]["p_ind"] for r in res])
        pc = np.mean([r["christoffersen"][side]["p_cc"] for r in res])
        print(f"  {side}: hit={hr:.4f}  p_uc={pu:.3f}  p_ind={pi_:.3f}  p_cc={pc:.3f}")

    a.out.write_text(json.dumps({
        "barrier_pct": BARRIER_PCT.tolist(),
        "per_model": json.loads(agg.to_json(orient="index")),
        "vol_qlike": {k: float(np.mean([r["vol"][k] for r in res]))
                      for k in ("noctua", "log_har", "persistence")},
        "christoffersen": [r["christoffersen"] for r in res],
    }, indent=2, default=float) + "\n")
    print(f"\nwritten -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
