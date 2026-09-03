# Literature review — and what I did not accept from it

Three Haiku agents were sent to read the quantitative-finance literature on
questions this project had reached the edge of. Their reports are summarised
here **with a verdict attached to each substantive claim**, because a research
assistant's output is a draft, not a result, and one of the three reports has a
headline conclusion that is wrong in a way that would have damaged the model.

Verdicts used below:

| verdict | meaning |
|---|---|
| **ADOPTED** | acted on, or already independently in place |
| **SOUND, UNUSED** | I believe it, it does not apply here or costs more than it returns |
| **UNVERIFIED** | plausible, the citation was not checked, nothing depends on it |
| **REJECTED** | checked against this project's own data and contradicted |

---

## 1. Overfitting control in quantitative finance

The most useful of the three, and the one whose recommendations most closely
match what this repo had already been forced into by other routes.

| claim | verdict | note |
|---|---|---|
| Deflated Sharpe Ratio (Bailey & López de Prado 2014, *JPM* 40(5) 94–107) corrects a Sharpe for the number of trials | SOUND, UNUSED | This project reports no Sharpe and runs no backtest with a P&L. There is nothing to deflate. Would apply immediately if a trading rule were ever built on top. |
| PBO / CSCV (Bailey, Borwein, López de Prado & Zhu) estimates the probability that the selected configuration is in-sample-best only by luck | SOUND, UNUSED | Needs a large configuration set to resample. The capacity and blend sweeps here are small and already reported in full rather than by their winner. |
| Purged k-fold with an embargo prevents label overlap leaking across a split boundary | **ADOPTED** | Already in `noctua/splits.py`, reached independently — every boundary is embargoed by `max(H)` hours on both sides. The report confirms rather than changes it. |
| Harvey, Liu & Zhu (2016, *RFS* 29(1) 5–68) argue for t ≥ 3.0, not 2.0, once multiple testing is accounted for | **ADOPTED** in spirit | The reason `eval/efficiency.py` reports "t-like" as descriptive and refuses to print a p-value from six folds. A t of +2.03 on QLIKE would be "significant" at the conventional threshold and is not claimed as such. |
| Fractional differentiation preserves memory while inducing stationarity | SOUND, UNUSED | The features here are already stationary by construction — log-vol rates, ratios, shares. There is no price level in the model to difference. |
| Overlapping observations inflate effective sample size (Britten-Jones, Neuberger & Nolte) | **ADOPTED** | Independently measured earlier: the 76× overlap inflation, and the reason headline numbers are computed only on non-overlapping production anchors. |
| Meta-labelling, MinTRL / PSR | UNVERIFIED | Not checked, nothing depends on them. |

The report separated what it had verified from what it had not, unprompted.
That is the behaviour I would want and it is why this section needed the least
correction.

---

## 2. Continual learning under distribution shift

The strongest report, and the one that directly produced working code.

| claim | verdict | note |
|---|---|---|
| Adaptive Conformal Inference (Gibbs & Candès 2021, arXiv:2106.00170) gives O(1/T) long-run coverage with no distributional assumption | **ADOPTED** | Implemented in `serve/selfimprove.py` and validated closed-loop against a misspecified tail. The guarantee held; the method still lost on the proper score. See below. |
| E-values / test martingales (Ramdas, Grünwald, Vovk) with Ville's inequality permit continuous monitoring without alpha-spending | **ADOPTED** | Implemented and validated: measured false-positive rate 0.0080 at α = 0.01 and 0.0895 at α = 0.10, against bounds of 0.01 and 0.10. |
| GEM's constraint-based formulation prevents backward transfer degradation | SOUND, UNUSED | Designed for gradient updates. Nothing here takes a gradient step online, deliberately — 19,134 parameters chasing a few hundred nightly episodes is the overfitting this project exists to refuse. The e-value veto serves the same purpose without a gradient. |
| ADWIN for drift detection | SOUND, UNUSED | The e-processes already provide anytime-valid change detection on the quantity that matters (relative loss). A second detector on a different quantity would add a second thing to tune. |
| OGD O(√T) / FTRL O(log T) regret bounds | UNVERIFIED | Standard results, not checked, nothing depends on them. |

**One correction the report did not make and I did.** It presented ACI as an
improvement. Measured against the *shipped* incumbent — which already includes
`serve/adaptive.py`'s causal volatility recalibration — ACI improves coverage
on every asset and **loses the proper score on three of four**, pooled e-value
9.75e-186. Its guarantee is about coverage, and coverage is not skill. The
report cannot be faulted for this; it was asked about methods, not about this
model. But "the literature endorses it" is not "it works here", and only the
second one was allowed to decide.

---

## 3. Volatility forecasting — one REJECTED headline

This report's central recommendation is wrong, and acting on it would have
made the model worse.

> **The claim.** *"For a 19-hour realized volatility forecast, is √H scaling
> defensible? Answer: No."* — recommending σ_H ∝ H^0.1–0.15 from rough
> volatility instead of H^0.5.

**REJECTED.** It conflates two different exponents:

- The **Hurst exponent of the log-volatility process** (H ≈ 0.1, Gatheral,
  Jaisson & Rosenbaum). This describes how volatility *itself* fluctuates over
  time — the roughness of the σ path.
- The **scaling of integrated realized volatility across a forecast horizon**
  (≈ H^0.5). Variance accumulates in time, so RV over a window of length H
  grows like √H. Rough volatility makes the σ *level* wander; it does not stop
  variance accumulating.

These are different quantities and the paper does not claim the first governs
the second.

Rather than argue it, I measured it. Regressing log median RV on log H over the
production anchors (`eval/by_expiry.py`):

```
RV ~ H^0.4808        against the 0.5 the model assumes
```

Worth a 0.974× correction across the entire 6h–24h span. Had the model been
rebuilt to H^0.1 as recommended, the 19-hour σ would have been wrong by roughly
a factor of two.

What the same report got right, and is worth keeping:

| claim | verdict | note |
|---|---|---|
| HAR is very hard to beat; ML does not consistently improve on a properly-fitted HAR (Audrino et al. 2024, arXiv:2406.08041; Kılıç 2025, FEDS WP 2025-61) | **ADOPTED** | Independently confirmed here in the least comfortable way: `log_har_gauss` still leads NOCTUA on barrier DSC in `BENCHMARK.md` section 2, and both arms of the efficiency ablation remain ~6% behind it. |
| Direct vs iterated forecasting differ materially at longer horizons (MIDAS) | SOUND, UNUSED | Genuinely interesting given that skill declines monotonically with expiry (`eval/by_expiry.py`), and a composed short-horizon forecast is the natural response. It needs the joint law of the running maximum, not the marginals — a real piece of work, not a tweak, and untouched. |
| Forecast reconciliation across horizons | UNVERIFIED | Not checked. |

---

## What this exercise is worth

Two of three reports were substantially reliable and one had a wrong headline
stated confidently. The wrong one was caught by measuring the claim against
this project's own data — a twenty-line regression — rather than by
recognising the error from expertise.

That is the only method that generalises, and it is the reason none of these
reports was allowed to change the model on its own authority. Every **ADOPTED**
row above is either something the repo had already arrived at independently, or
something that was implemented *and then validated against a case with a known
answer* before being believed. The one recommendation that arrived with the
most confident phrasing is the one that was wrong.

*Educational research only. Not financial advice.*
