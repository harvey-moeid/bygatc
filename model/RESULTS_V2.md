# NOCTUA v2 — capacity, committees, and a hierarchy that did not work

Three questions were asked and answered empirically. Two of the answers
contradict the premise they started from, which is why they are worth reading.

Protocol throughout is identical to v1 (`RESULTS.md`): expanding-window
walk-forward, embargoed splits, every number on the production slice (19 h
window opened 17:00 UTC, one non-overlapping episode per day, 2021-2026).

---

## 1. "Increase the parameters — we targeted 1 M and only used 50 k"

**Measured: more capacity makes it worse.** Monotone, on both metrics.

| hidden | params | QLIKE vs Log-HAR | p | barrier err |
|---|---|---|---|---|
| **32** | **6,378** | **−4.65 %** | **0.0000** | **2.706 pp** |
| 64 | 16,778 | −3.96 % | 0.0006 | 2.778 pp |
| 128 | 49,866 | −2.79 % | 0.0426 | 2.926 pp |
| 256 | 165,194 | −2.79 % | 0.0174 | 3.133 pp |
| 512 | 592,458 | −3.38 % | 0.0032 | 2.938 pp |

Shrinking the network **8×** nearly doubled the volatility edge (−2.79 % →
−4.65 %) and moved it from marginal to decisive (p = 0.043 → p < 0.0001).

The cause is sample size, and it is arithmetic rather than opinion. A 19-hour
window anchored hourly overlaps its neighbour by 18/19, so the 189,831 training
episodes carry only **2,498 independent observations** — a 76× inflation. At
width 128 the model already holds 20 parameters per effective observation; at
1 M it would hold ~400. Capacity buys variance here, not signal.

This also matches the published result the v1 plan was built on
(arXiv:2607.05291): across 50 assets, the *smallest* foundation model tested
(<1 M params) was the only one of nine to beat Log-HAR.

## 2. "Build many specialists and let them interact"

**Measured: yes — this is the real gain.** Four heterogeneous specialists,
pooled by Vincentization:

| specialist | what it knows | what it cannot do |
|---|---|---|
| neural | conditional, state-dependent shape | overfits; noisy in the body |
| gaussian | exact first-passage law, zero estimation variance | Gaussian tails are wrong for crypto |
| empirical | true fat tails, no parametric assumption | noisy at 1-in-200 |
| EVT (peaks-over-threshold) | principled tail extrapolation via GPD | says nothing about the body |

Pooling is **Vincentization** — averaging quantile *functions*, not CDFs.
Ranjan & Gneiting (2013) proved a linear pool of calibrated forecasts is
necessarily **overdispersed**, which would destroy the one thing this model is
good at. Quantile averaging also keeps monotonicity, so `safe_level` stays
exactly invertible.

Two weighting schemes are scored, because only one of them ships. The
artifact hard-codes 1/4 per specialist; `Committee.fit` estimates
level-dependent weights by SLSQP. Quoting the fitted number while shipping the
equal-weight one would report a different estimator from the released model,
so both are in the table and **the equal-weight column is the headline**.

| α | NOCTUA v1 | Gaussian | Committee (fitted) | **Committee (equal — shipped)** |
|---|---|---|---|---|
| 1 % | 1.089 | 3.326 | 1.090 | **1.090** |
| 2 % | 1.446 | 3.527 | 1.381 | **1.381** |
| 5 % | 2.655 | 3.765 | 1.891 | **1.868** |
| 10 % | 3.279 | 2.710 | 2.177 | **2.177** |
| 20 % | 3.678 | **2.006** | 3.078 | 3.078 |
| 30 % | 3.861 | **3.693** | 5.220 | 5.220 |
| **mean** | 2.668 | 3.171 | 2.473 | **2.469** |
| **mean, α ≤ 10 %** | 2.118 | 3.332 | 1.635 | **1.629** |

In the range an option seller actually operates in, calibration error drops
**23 %**. Above α = 20 % the committee is worse and the Gaussian should be
used instead — reported, not hidden.

The two weighting schemes differ by **0.006 pp**, and the fitted weights come
out at 0.239–0.272 across every level — uniform to within estimation noise.
That is the forecast-combination puzzle showing up a third time in this
project, and it is why fitting was dropped: the estimator that fits nothing is
the one that scores best.

### The bug that decided it

The committee first came out at 3.199 pp — clearly *losing*. The cause was a
genuine modelling error, not tuning: NOCTUA's `safe_level` integrates over its
uncertainty about σ (32 quadrature atoms), while the three analytic specialists
conditioned on a single point estimate. **A predictive distribution built on a
point estimate of a parameter is under-dispersed relative to one that
integrates over it.** Pooling one hierarchical forecast with three
under-dispersed ones pulled every level too close to spot (α = 5 % was touched
7.1 % / 10.2 % of the time).

Mixing all specialists over the same σ atoms fixed it: 3.199 → **2.455**. The
correction widens the deep tail (1.16× at α = 0.5 %) and barely moves the body,
exactly as integrating over parameter uncertainty should.

## 3. "Make NOCTUA a parent that spawns specialist children"

**Measured: implemented rigorously, it does not help.**

The disciplined form of this is a hierarchical mixture of experts (Jacobs,
Jordan, Nowlan & Hinton 1991): a gating network reads market state — vol level,
vol-of-vol, position within the year, weekend fraction, jump share — and emits
per-episode weights over the children. It was initialised at exactly equal
weights (W = 0 ⇒ uniform softmax) so it starts at the flat committee and can
only be credited with what it adds.

It added nothing:

```
child        mean weight    sd ACROSS EPISODES
neural            0.919              0.0000
gaussian          0.038              0.0000
empirical         0.021              0.0000
evt               0.021              0.0000
```

The gate put 92 % on one child and **its weights do not vary with market state
at all**. Gated calibration error 2.667 pp — statistically the same as NOCTUA
alone (2.640) and worse than the flat committee (2.455).

Why it fails is interpretable, and it is an objective mismatch. The gate is
fitted by pinball loss, which rewards the single *sharpest* forecaster; the
metric that matters is *calibration*, which rewards the diversity the ensemble
provides. Given freedom to concentrate, the gate concentrated — the same
overfitting the capacity study predicted, arriving through a different door.

This is the "forecast combination puzzle" in its usual form: **equal weights are
hard to beat.** Both the level-dependent weights (§2) and the state-dependent
gate (§3) converged to roughly uniform or degenerate solutions. The gain comes
from *having* heterogeneous, properly-dispersed members — not from cleverness
about how to weight them.

---

## What v2 ships

- width **32** instead of 128 (6,378 params, 8× smaller)
- **3-seed** average — free variance reduction
- flat **equal-weight** committee of the four specialists, σ-mixed
- gating network **built, measured, and rejected**; code retained so the
  negative result stays reproducible

| | v1 shipped | **v2** |
|---|---|---|
| volatility QLIKE vs Log-HAR | −2.79 % (p = 0.043) | **−4.04 % (p = 0.0002)** |
| barrier err, α ≤ 10 % | 2.118 pp | **1.629 pp** |
| network params | 49,866 | **6,378 × 3 seeds** |

## Post-merge correction: the barrier curve was clamped outside the grid

Found in review after v2 merged, and fixed in a follow-up. It is the most
consequential defect in this project so far, so it is recorded here in full.

`ALPHA_GRID` spans α ∈ [0.005, 0.5], so the pooled quantile curve only speaks
about barriers between the median excursion and the 99.5th percentile.
`touch_prob` read it with `np.interp(..., left=0.5, right=0.0)` — a flat clamp.
Every barrier nearer than the median excursion was reported as **exactly
0.50**, and every barrier past the 99.5th percentile as **exactly 0.00**. The
published forecast said a 10 % overnight move had *zero* probability of being
touched:

| barrier | v1 | v2 as merged | **v2 fixed** |
|---|---|---|---|
| +0.5 % | 0.6034 | 0.5000 ← clamp | **0.6144** |
| +7.5 % | 0.0067 | 0.0000 ← clamp | **0.0029** |
| +10 % | 0.0018 | 0.0000 ← clamp | **0.0013** |

Both ends now extrapolate, each with the closed form its endpoint already
implies:

- **near** — the reflection-principle survival `P(M ≥ u) = 2Φ(−u/s)`, with `s`
  set so the curve passes exactly through the pooled median level. Tends to 1
  as `u → 0`, as a touch probability must.
- **far** — a power law `α(u) = α₀·(u/u₀)^−k`, with `k` fitted from the two
  deepest pooled quantiles. Fitted from the *pooled* curve rather than from the
  EVT member's ξ, because both fitted ξ are **negative** (bounded support)
  while the pooled tail is a scale mixture over 32 σ atoms and so is fatter
  than any single standardized GPD.

Both are continuous at the seam to machine precision, so `safe_level` still
inverts `touch_prob` exactly — now for α outside the grid too. Interior values
are bit-identical: the fix touches only the two extrapolation regions.

Why the original suite missed it: the far-tail check asserted
`touch_prob(5.0) < 0.05`, which a hard 0.0 satisfies trivially, and the
monotonicity check used `≤` rather than `<`, which a flat clamp also satisfies.
Both are now strict, and four checks assert the endpoints are not clamp
artifacts.

## Correction: the headline metric in this file is cheatable

`model/BENCHMARK.md` supersedes the barrier numbers above.

Mean |coverage error| -- the 1.629 pp quoted throughout this document -- is not
a proper scoring rule. It rewards a forecaster whose levels break alpha% of the
time, which is exactly what fitting an unconditional distribution achieves. In
the adversarial benchmark a trivial `scaled_clim` baseline (unconditional shape
x trailing vol) scores **1.360 pp and beats the shipped model**, and a constant
input-blind climatology beats both Log-HAR and persistence on it.

The tables above are still correct as *calibration diagnostics*. They are not
evidence of skill, and the 22-23% improvement should not be read as one. Under
strictly proper scores NOCTUA does win pinball, CRPS and log score, and it does
carry real discrimination -- see `BENCHMARK.md` for the numbers that survive,
including the one it loses.

*Educational research only. Not financial advice.*
