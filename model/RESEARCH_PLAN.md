# NOCTUA — A Small, Calibrated Barrier Model for the BTC Overnight Option-Seller's Window

**Nocturnal Overnight Calibrated Tail & Underlying Analyzer**

*Research and development plan. Version 1.1 — revised after first contact with the data (see §0, §2.4).*

---

## 0. Executive summary

The dashboard's Kronos dependency is dead: `data/kronos.json` last carried a genuine
source timestamp of `2026-07-04 11:00:26 UTC`, ~880 hours stale as of this writing. The
public demo page has stopped updating, and the scraper in `scripts/parse-kronos.js` has
been faithfully re-committing a fossil ever since.

Rather than resurrect a scrape of a general-purpose foundation model, this project builds
a **purpose-built specialist** for exactly one decision:

> At **22:30 IST (17:00 UTC)** an option seller opens a position on the Delta Exchange
> BTC daily contract that settles at **17:30 IST (12:00 UTC) the next day**. Over that
> **19-hour window**, how far can price travel, in which direction, and **which levels are
> strong enough that they will not break**?

The model targets **< 1 M parameters** and **< 50 ms CPU inference**, against Kronos-small's
24.7 M parameters plus tokenizer and 20–60 s per forecast on CPU. The claim is not that
NOCTUA is a better general model of financial candlesticks — it is not, and will not be.
The claim is narrower and defensible: **on this one window, for the three functionals a
seller actually trades, a small model with the right structure and the right loss beats a
large general model used through Monte-Carlo rollouts.**

### The central structural insight

**The edge here is not scale, it is specification** — modelling the functional the seller
actually trades (the barrier), with a proper scoring rule and an explicit calibration step,
instead of Monte-Carlo-sampling a general generative model and reading a summary statistic
off the samples.

> **Correction, v1.1 — a claim this plan originally made and the data killed.**
>
> Version 1.0 argued that the decisive edge was *clock anchoring*: that the 17:00→12:00 UTC
> window excludes the loud 13:00–16:00 UTC US-macro block, so a clock-aware model would
> avoid structurally over-forecasting volatility. **Measured on our own 7.68 M-bar sample
> (2017-08+), that claim is wrong in magnitude.** Anchor hour explains **0.22 %** of the
> variance of log RV at H = 19 h, and the 17:00 anchor ranks a thoroughly unremarkable
> **11th of 24**. The reason is arithmetic and should have been obvious: a 19-hour window
> covers 79 % of the day, so every anchor averages over nearly the same hours. The clock
> effect is real but only at short horizons — the max/min anchor ratio for median RV is
> **1.41× at H = 6 h, 1.23× at H = 12 h, 1.10× at H = 19 h, 1.01× at H = 24 h.**
>
> Clock position is retained as a feature (it is free and non-negative in value), but it is
> demoted from thesis to footnote. See §2.4 for what the measurement actually found.



---

## 1. Problem formalization

Let `S_t` be the BTC price process. Fix the decision epoch `τ = 17:00 UTC` on day `d` and
the settlement epoch `T = 12:00 UTC` on day `d+1`, so `H = T − τ = 19 h`.

Using only the filtration `F_τ` (information available at `τ`), forecast the **joint law**
of the path `{S_t : t ∈ [τ, T]}` through the five functionals that determine a daily option
seller's P&L:

| Symbol | Definition | What the seller uses it for |
|---|---|---|
| `R` | `log(S_T / S_τ)` | Settlement. Direction, and whether a short strike finishes ITM |
| `RV` | `√( Σ r_i² )` over the window, `r_i` = 1-min log returns | Is implied vol rich or cheap? Position sizing |
| `M⁺` | `max_{t∈[τ,T]} log(S_t / S_τ)` | Maximum favourable/adverse excursion **up** |
| `M⁻` | `min_{t∈[τ,T]} log(S_t / S_τ)` | Maximum excursion **down** |
| `N(u)` | `1{M⁺ ≥ u}` or `1{M⁻ ≤ u}` | **Barrier touch** — did the strike get breached intraday? |

### 1.1 The deliverable is the barrier survival curve

An option seller does not want a point forecast. They want to choose a strike and know the
probability it breaks. So the model's primary output is the pair of **survival curves**

```
    S⁺(u) = P( M⁺ ≥ u | F_τ )     for u > 0
    S⁻(l) = P( M⁻ ≤ l | F_τ )     for l < 0
```

from which the user's actual question — *"which level is strong enough to sell against and
sit comfortably?"* — is answered by inversion:

```
    K⁺(α) = inf { u : S⁺(u) ≤ α }        the α-safe call strike
    K⁻(α) = sup { l : S⁻(l) ≤ α }        the α-safe put strike
```

At `α = 0.05`, `K⁺(0.05)` is the level that historically breaks on 1 day in 20. **This is
the model's headline number**, and it is a strictly richer object than Kronos's scalar
"Upside Probability".

A second-order but important distinction: `S⁺` is a **touch** (first-passage) probability,
not a terminal probability. `P(M⁺ ≥ u) > P(R ≥ u)` always, and for a 19-hour window at
realistic volatility the gap is large — roughly a factor of ~1.7–2.0 near the money under a
driftless diffusion (reflection principle). A seller who prices a strike off terminal
probability and then gets stopped out on an intraday wick has mispriced their own risk by
almost 2×. **Modelling the running extremum directly, rather than the terminal return, is
one of the concrete places this model earns its keep.**

### 1.2 Losses

Every head is trained with a **strictly proper scoring rule** for the quantity it predicts —
never MSE on a probability, never MAE on a distribution:

- Distribution of `R`: **CRPS** and **pinball (quantile) loss** on a grid of levels.
- Distribution of `RV`: pinball loss in log space; evaluated with **QLIKE**, which is
  robust to noise in the volatility proxy and is the standard in this literature.
- Barrier indicators: **log-loss / Brier**, then explicitly **recalibrated** (§6).

---

## 2. Literature review and positioning

### 2.1 What Kronos is, precisely

Kronos (Shi, Fu, Chen, Zhao, Xu, Zhang & Li; Tsinghua; AAAI 2026; arXiv:2508.02739) is a
decoder-only autoregressive transformer over **discrete tokens of OHLCVA candles**. A
Transformer autoencoder with **Binary Spherical Quantization** maps each candle to a k-bit
code, factorized hierarchically into a coarse and a fine subtoken; the decoder predicts
`p(b_t | b_<t) = p(b_c | b_<t) · p(b_f | b_<t, b_c)`. It is pre-trained on **> 12 billion
K-line records from 45 exchanges**, across stocks/crypto/forex/futures and 7 granularities.

| Variant | Params | Context |
|---|---|---|
| Kronos-mini | 4.1 M | 2048 |
| Kronos-small | 24.7 M | 512 |
| Kronos-base | 102.3 M | 512 |
| Kronos-large | 499.2 M | 512 |

It is a genuinely strong piece of work. Its reported gains are real: +93 % RankIC over the
leading general TSFM on price forecasting, **−9 % MAE on realized volatility** versus its
closest competitor, +22 % on generative fidelity.

### 2.2 Where a generative foundation model is structurally weak for *this* task

Four specific, checkable weaknesses — not hand-waving:

**(a) Monte-Carlo estimation variance in the tail.** Kronos produces probabilities only by
sampling rollouts. The dashboard's own `kronos_local/app.py` uses `N_SAMPLES = 24`. The
standard error of a probability estimate from `n` Bernoulli rollouts is `√(p(1−p)/n)`. At
the 5 % barrier a seller cares about, with `n = 24`, that is **±4.4 percentage points** —
the estimate is `5 % ± 4.4 %`, which is not a usable number for strike selection. To pin a
5 % tail to ±0.5 pp you need `n ≈ 1 900` rollouts. At the repo's own measured 20–60 s per
rollout on CPU, that is **10–30 hours per forecast**. The tail probabilities a seller
actually needs are, on a free CPU tier, computationally out of reach by three orders of
magnitude. A model that outputs the tail probability *directly* has zero sampling error.

**(b) Objective mismatch.** Kronos optimizes token-level negative log-likelihood over the
full candle sequence. That is a proper scoring rule for *the candle sequence*, not for the
scalar functionals `RV`, `M⁺`, `M⁻`. Plug-in estimation — sample paths from a generative
model, then compute a functional — is consistent but **statistically inefficient** relative
to direct regression on that functional, and it inherits the generative model's calibration
error in whichever region of path-space the functional depends on. Error also compounds over
19–24 autoregressive steps.

**(c) No clock anchoring.** Kronos forecasts *n* steps ahead from the last candle, with
learned temporal embeddings shared across 45 exchanges, 7 granularities and four asset
classes. It has no mechanism to know that *this particular* 19-hour window omits
13:00–16:00 UTC. Per §0 that is the difference between ~37 bps/h and ~80 bps/h hours — a
first-order effect on the answer.

**(d) No calibration guarantee.** Nothing in the training objective forces the stated 5 %
to occur 5 % of the time out-of-sample. For a seller sizing positions on those numbers,
calibration is the whole product.

### 2.3 The decisive empirical precedent

*"Forecasting Realized Volatility with Time Series Foundation Models: A Comparison with
Econometric Benchmarks"* (arXiv:2607.05291, July 2026) ran exactly the experiment that
matters here: **nine zero-shot TSFMs against eight econometric specifications across 50
assets**, on the VOLARE dataset.

The results are unambiguous and directly support this project's design:

> *"...only Tiny Time Mixers (TTM), the **smallest model in the evaluation (< 1 M
> parameters)**, beats Log-HAR at every horizon on the raw zero-shot forecasts, and only by
> a small margin of roughly **1.3 to 1.8 %**. The other eight TSFMs do not beat a
> well-specified Log-HAR on average."*

> *"Our most durable finding is that performance varies so widely across TSFM architectures
> that **which** TSFM one chooses matters more than **whether** to use a TSFM or an
> econometric model at all."*

Three conclusions drive our architecture:

1. **Scale is not the bottleneck for volatility forecasting.** The only foundation model to
   beat the econometric benchmark was the smallest one tested, by 1–2 %. The user's
   intuition — that a small model can match a large one on a targeted task — is not
   optimism here; it is the published result.
2. **Log-HAR is the true adversary, not Kronos.** Any honest claim of superiority must be
   made against a well-specified Log-HAR, which is far harder to beat than a general TSFM.
   We therefore **embed Log-HAR inside the model as a residual base** (§4.1), so we inherit
   its performance by construction and learn only the correction.
3. **Beating it requires information the benchmark does not have.** Ours is: exact clock
   position, 1-minute realized measures, path functionals, and multi-anchor training.

### 2.4 What the data actually says (measured, not assumed)

Before fitting anything, the three assumptions this architecture rests on were tested
directly on the built episode table (BTC/USD, 2017-08 → 2026-08, H = 19 h). Results drive
the design, including where they contradicted it.

**(i) Volatility is strongly predictable — Stage A is justified.**

| lag (days) | 1 | 2 | 3 | 5 | 10 | 22 |
|---|---|---|---|---|---|---|
| autocorr of log RV | 0.744 | 0.643 | 0.615 | 0.570 | 0.479 | 0.438 |

A crude log-HAR on the (1, 5, 22)-day cascade already reaches **R² = 0.605** in-sample. The
slow decay is the classic long-memory signature that makes HAR work. This is where the
predictability lives, and it is why Stage A is built around an explicit Log-HAR base.

**(ii) The scale-invariance prior is real — Stage B is justified.** Splitting episodes by
realized-vol quintile, raw `M⁺` varies **~4.4×** across quintiles while the standardized
`m⁺ = M⁺/RV` is nearly flat:

| RV quintile | Q1 low | Q2 | Q3 | Q4 | Q5 high | spread |
|---|---|---|---|---|---|---|
| median `M⁺` (%) | 0.67 | 1.18 | 1.60 | 2.08 | 2.97 | **4.4×** |
| median `m⁺ = M⁺/RV` | 0.639 | 0.672 | 0.693 | 0.666 | 0.564 | **1.23×** |

Dividing by the volatility scale removes ~80 % of the variation in the barrier functional.
That is exactly the seam the Stage-A/Stage-B factorization cuts along, and it is what lets a
sub-1 M-parameter model work on ~3,300 native episodes.

Better still, the level is close to theory: for a driftless diffusion the running maximum
over a window of total vol `σ` satisfies `median(M⁺) = 0.6745 σ` (reflection principle,
`max ~ |N(0,1)|·σ`). We measure **0.64–0.69**. So the Brownian barrier baseline is nearly
*right at the median* — the model's job is to learn the **deviations**, which is precisely
where a seller's money is: the empirical 95th percentile of `m⁺` runs 1.61–2.01 against the
Gaussian 1.96, and the quintile pattern is non-monotone (a hump at Q3, a marked drop at Q5).
Fat tails in quiet regimes, compressed tails in already-violent ones.

**(iii) The dominant calendar signal is the weekend, not the clock.** Day-of-week explains
**5.35 %** of log-RV variance — **24× more than anchor hour (0.22 %)**:

| day | Mon | Tue | Wed | Thu | Fri | **Sat** | Sun |
|---|---|---|---|---|---|---|---|
| median RV over 19 h (%) | 2.447 | 2.502 | 2.535 | 2.490 | 2.359 | **1.777** | 2.098 |

Saturday realizes **30 % less volatility than Wednesday**. This independently reproduces the
central finding of this repo's own `DAILY_EXPIRY_ALPHA.md` ("the Saturday lull is the single
largest, cleanest edge found in this entire project") from a completely different estimator
— 5-minute realized variance on Bitstamp here, versus Black-Scholes P&L simulation on
Deribit DVOL there. Two independent routes to the same structure is the strongest evidence
available in this project, and day-of-week is therefore a first-class feature.

**(iv) Cross-validation of the RV estimator.** Median annualized RV from 24-hour windows
tracks the daily-return realized vol table published in `BTC_VOL_RESEARCH.md` — 2015: 60.1
vs 60.0, 2016: 47.0 vs 49.9, 2017 the peak in both, 2023/2025 the troughs in both. Our
medians sit systematically below their standard deviations, as they must for a right-skewed
quantity. The estimator is sound.

### 2.5 Econometric foundations we build on

- **Corsi (2009)** — the HAR model. Cascading daily/weekly/monthly realized-volatility
  components approximate long memory with three regressors. Still the workhorse benchmark
  after 17 years.
- **Log-HAR** — HAR in log space. Handles the right-skew of RV, stabilizes variance, and
  in arXiv:2607.05291 outperforms plain HAR and most of its augmented variants.
- **Andersen, Bollerslev & Diebold** — realized variance from intraday returns; jumps and
  bipower variation.
- **Barndorff-Nielsen & Shephard** — bipower variation, realized semivariance.
- **Patton & Sheppard (2015)** — good/bad realized semivariance and **signed jump
  variation**; downside semivariance carries most of the predictive content for future vol.
  This is the leverage effect made measurable, and it matters enormously to a put seller.
- **Bollerslev, Patton & Quaedvlieg (2016)** — HARQ; realized quarticity measures the
  *measurement error* in RV, and attenuating the HAR coefficients when the estimate is noisy
  improves forecasts.
- **Parkinson / Garman-Klass** range estimators — efficient variance estimates from OHLC.
- **Koenker & Bassett** — quantile regression, pinball loss.
- **Gneiting & Raftery** — proper scoring rules, CRPS.
- **Vovk / Shafer / Lei et al.** — conformal prediction for distribution-free coverage.

---

## 3. Data strategy

### 3.1 Primary source

**Bitstamp BTC/USD 1-minute OHLCV**, via `ff137/bitstamp-btcusd-minute-data`
(MIT, GitHub, daily-updated):

- `2012-01-01` → present (verified live to `2026-08-10 01:57 UTC` at time of writing)
- ~7.68 M 1-minute bars, stated no missing minutes, no duplicates, no nulls
- Real BTC/**USD** spot on a regulated venue — not a USDT perp, so no stablecoin-depeg
  artifacts in the price series

Why 1-minute and not hourly: the labels `RV`, `M⁺`, `M⁻` are **path functionals**. Realized
variance measured from 1-minute returns has far lower measurement error than from hourly
returns (the RV literature is unanimous that better realized measures translate directly
into better forecasts), and running extrema measured at 1-minute resolution are the ground
truth a barrier actually experiences.

### 3.2 Sample period

Main sample begins **2017-08-01**. Pre-2017 BTC microstructure (Mt. Gox aftermath, thin
books, `volume = 0.0` minutes in 2012) is a different asset. The repo's own vol study shows
2015–2016 realized vol of 50–60 % against a post-ETF 48 %, but with radically different
liquidity; including it would train the model on a market that no longer exists. It is
retained as a **stress-test set**, not a training set.

### 3.3 Regime awareness

`BTC_VOL_RESEARCH.md` documents a structural break at the **spot-ETF launch, 2024-01-11**:
pre-ETF realized vol averaged 69.3 %, post-ETF 48.3 % — a ~30 % compression. The model must
not be trained as if these are one regime. Handled by (i) time-decayed sample weighting,
(ii) walk-forward evaluation that always tests on the future, (iii) an explicit regime
feature, and (iv) a reported breakdown of performance pre/post break.

### 3.4 The sample-size problem, and how multi-anchor training solves it

One 17:00-UTC episode per day from 2017-08 to 2026-08 is only **~3,290 episodes**. That is
far too few to fit a neural network of any size without severe overfitting, and it is the
single biggest technical risk in this project.

**Solution — multi-anchor training.** The 19-hour-window forecasting problem is the same
problem at every anchor hour; only the clock position differs. Train on windows anchored at
**every hour of the day**, with anchor-hour supplied as an explicit cyclical feature:

```
    3,290 days × 24 anchors  ≈  79,000 episodes        (24× more data)
```

The model learns the *shared* mapping from market state to path distribution, and learns the
clock as a conditioning variable — which is exactly the structure we want it to have. The
17:00 anchor is then one slice of a well-estimated surface rather than a separately fitted
model. This is a data-efficiency trick available **only** to a specialist that knows the
problem has this symmetry.

Two consequences that must be handled honestly:

- Overlapping windows are **strongly dependent**. All significance testing uses a
  **moving-block bootstrap**; the headline out-of-sample evaluation is restricted to
  **non-overlapping 17:00 anchors** so that reported numbers describe the real trade.
- Train/test splits are cut **by date, with a purge gap ≥ 19 h**, so no test window shares
  any minute with a training window (embargoed walk-forward, per López de Prado).

**Secondary augmentation:** train jointly on ETH/USD and other liquid pairs with an asset
embedding, then evaluate cross-asset transfer. This both adds data and produces the
hallucination test the user asked for.

### 3.5 Validation and hallucination testing

- **Cross-venue check:** verify Bitstamp extrema against a second venue. Bitstamp is thinner
  than Binance/Coinbase, so isolated wicks may be venue-idiosyncratic. Since barrier touches
  are exactly what we predict, a Bitstamp-only wick would teach the model a touch that a
  Deribit-settled option would never have registered. **Wick de-noising and cross-venue
  agreement are a required preprocessing step, not an optional one.**
- **Other instruments:** run the trained model on ETH, and on a deliberately
  out-of-distribution series. A well-behaved model should widen its intervals, not emit
  confident nonsense.
- **Null tests:** feed IID Gaussian noise with matched variance, and phase-randomized
  surrogates. The model must collapse toward the unconditional distribution. Any residual
  "signal" on a surrogate is a bug or leakage.

---

## 4. Model architecture

Design principle: **spend parameters where the predictability is, and use a near-universal
shape everywhere else.** Volatility *level* is highly predictable (R² ≈ 0.5–0.7 in log
space). Standardized path *shape* is close to distribution-free. Factorizing along that seam
is what makes < 1 M parameters sufficient.

```
                 features (≈ 60, all from OHLCV)
                              │
        ┌─────────────────────┴──────────────────────┐
        │                                            │
   STAGE A: volatility scale               STAGE B: standardized shape
   ────────────────────────                ─────────────────────────────
   Log-HAR linear base                     monotone quantile heads for
        + gated residual MLP                  r  = R  / σ̂
        ↓                                     m⁺ = M⁺ / σ̂
   predictive distribution                    m⁻ = M⁻ / σ̂
   over log RV  (quantiles)                ↓
        │                                  conditioned on a few shape
        │                                  features + clock + σ̂ level
        └──────────────┬───────────────────────────┘
                       │
              STAGE C: mixing + calibration
              ─────────────────────────────
              P(M⁺ ≥ u) = E_σ̂ [ 1 − F_{m⁺}(u / σ̂) ]
              then isotonic recalibration + conformal coverage
                       │
                       ▼
        S⁺(u), S⁻(l), K⁺(α), K⁻(α), P(R>0), quantiles of R, RV forecast
```

### 4.1 Stage A — volatility scale head

Predicts the conditional distribution of `log RV` over the window. Structured as an explicit
**Log-HAR base plus a learned residual**:

```
    log RV_pred  =  β' x_HAR  +  g_θ(z)
                    ─────────    ──────
                    Log-HAR      small gated MLP residual
                    (linear)     (the only learned nonlinearity)
```

This is deliberate. If the residual network learns nothing, the model **degrades gracefully
to Log-HAR** — the benchmark that arXiv:2607.05291 found eight of nine foundation models
could not beat. We can therefore never be much worse than the state of the practice, and any
gain is attributable to the residual. It also makes the result interpretable: we can report
exactly how much the neural part contributes.

Features:

- **HAR cascade:** realized vol over trailing 19 h / 1 d / 5 d / 22 d, in logs.
- **Seasonal HAR term:** RV of *the same clock window* on the previous 1/5/22 days. This is
  the clock-anchoring made explicit, and has no counterpart in a generic model.
- **Semivariances** (Patton–Sheppard): good vs bad realized variance, and **signed jump
  variation** — the leverage channel that matters most to a put seller.
- **Bipower variation** and the continuous/jump decomposition.
- **Realized quarticity** for HARQ-style attenuation when RV is noisily measured.
- **Range estimators:** Parkinson, Garman–Klass over multiple lookbacks.
- **Intraday variance profile:** the fraction of the last few days' variance realized in each
  of the window's constituent sessions.
- **Clock/calendar:** anchor hour (cyclical `sin`/`cos`), window length in hours, day of
  week, weekend-overlap fraction, month.
- **Regime:** vol-of-vol, RV percentile within a trailing year, post-ETF indicator, drawdown
  from 90-day high, distance to MA100.

Output: quantiles of `log RV` at a fixed grid, via monotone (cumulative-softplus) head,
trained with pinball loss.

### 4.2 Stage B — standardized shape head

Under a driftless diffusion with volatility `σ`, the law of `(R, M⁺, M⁻)/σ` is
*exactly* free of `σ`. Real BTC is not that — there is drift, leverage, jumps, and
vol-of-vol — but the invariance is a strong and correct inductive bias: it removes the
dominant source of variation before the network sees the data, so a small network can learn
the residual shape from limited episodes.

Stage B therefore models the law of `(r, m⁺, m⁻) = (R, M⁺, M⁻)/σ̂` conditioned on a compact
set of *shape* features — momentum/trend, recent return skew and kurtosis, vol-of-vol, jump
indicator, clock position, weekend flag, and the predicted vol level itself (so the model can
learn that the shape is not perfectly scale-invariant).

Outputs three **monotone quantile functions**, built as a cumulative sum of softplus
increments so monotonicity holds by construction and quantile crossing is impossible. Trained
with pinball loss on a dense level grid, plus a **coupling loss** enforcing the pathwise
constraints that must hold on every real path:

```
    m⁻  ≤  min(0, r)        and        m⁺  ≥  max(0, r)
```

Any model that can violate these is not modelling a path. Enforcing them is free accuracy and
a strong regularizer.

### 4.3 Stage C — mixing and calibration

The seller's barrier probability integrates Stage B over Stage A's uncertainty about scale:

```
    P(M⁺ ≥ u | F_τ)  =  E_{σ̂ ~ StageA} [ 1 − F_{m⁺}( u / σ̂ ) ]
```

evaluated by quadrature over Stage A's predictive quantiles — tens of microseconds, fully
deterministic, **zero Monte-Carlo error**. This is the direct replacement for Kronos's 24
rollouts, and it is both faster and exact.

Then, because calibration is the product:

- **Isotonic recalibration** of `S⁺`, `S⁻` and `P(R>0)`, fit on a rolling out-of-sample
  window (never on training data).
- **Conformal adjustment** of the quantiles for distribution-free coverage under
  exchangeability, with the standard caveat that exchangeability is only approximately true
  across a regime break — which is why we also report calibration separately per regime.
- **Reliability diagrams** shipped as a first-class artifact.

### 4.4 Budget

| | NOCTUA (target) | Kronos-small |
|---|---|---|
| Parameters | **< 1 M** | 24.7 M + tokenizer |
| Artifact size | **< 5 MB** | ~100 MB |
| CPU inference | **< 50 ms**, deterministic | 20–60 s for 24 noisy rollouts |
| Tail probability error | **0** (analytic) | ±4.4 pp at the 5 % barrier |
| Fits HF free 2 vCPU / 16 GB | comfortably | marginally, per repo's own MemoryError |

---

## 5. On distilling from Kronos

The user asked specifically whether we can train on Kronos's outputs, since it is open
source. Assessed honestly:

**Distillation is not the right primary strategy here, for a specific reason.** Distillation
pays off when the teacher knows something the student cannot learn from data — when labels
are scarce or expensive. Here the opposite holds: **ground truth is free and abundant.** We
have 14 years of 1-minute data and can compute the exact realized value of every target for
every historical window. A student trained on Kronos's forecasts is capped by the teacher's
accuracy; a student trained on realized outcomes is capped only by what is predictable.
Given that arXiv:2607.05291 found most TSFMs do not beat Log-HAR at volatility, distilling
would mean **inheriting a ceiling below our own baseline**.

There is also a hard practical constraint: this build environment's egress policy blocks
`huggingface.co`, so Kronos weights cannot be downloaded here (§8).

What we do instead, which is more valuable:

1. **Kronos as benchmark opponent, not teacher.** Ship `eval/kronos_baseline.py`, which runs
   Kronos-small over the identical historical windows with matched MC budgets and scores it
   with the identical proper scoring rules. This directly answers *"is NOCTUA superior to
   Kronos?"* — which is the actual goal — instead of assuming it.
2. **Optional distillation hook** retained as `train/distill.py`: an auxiliary loss matching
   Kronos's implied barrier curves, weighted `λ`, default `λ = 0`. Available to switch on if
   the benchmark shows Kronos adds information in some regime.

---

## 6. Evaluation protocol

Everything below is out-of-sample, walk-forward, with an embargo gap.

### 6.1 Splits

Expanding-window walk-forward. Train on `[start, t)`, calibrate on a held-out slice, test on
`[t + purge, t + purge + Δ)`, roll forward. Purge ≥ 19 h so no test window shares a minute
with training. Headline numbers restricted to **non-overlapping 17:00 UTC anchors**.

### 6.2 Baselines — the real bar

| Family | Models |
|---|---|
| Volatility | **Log-HAR** (primary), HAR, HAR-RS (semivariance), HARQ, EWMA/RiskMetrics, GARCH(1,1), rolling-window constant |
| Barrier | Gaussian/GBM closed form (reflection principle) at HAR vol; empirical historical touch frequency; Student-t diffusion |
| Direction | constant 50 %; momentum; the dashboard's existing RANGER formula |
| Foundation | **Kronos-small** MC rollouts (§5, run externally) |

Beating a random walk is not a result. **Beating Log-HAR and the reflection-principle
barrier is the result.**

### 6.3 Metrics

- `RV`: QLIKE (primary — robust to proxy noise), MSE, `R²` in logs.
- `R`: CRPS, pinball loss across the quantile grid.
- Direction: log-loss, Brier, AUC.
- **Barriers: calibration first.** Reliability diagrams; predicted vs realized touch
  frequency at α ∈ {1, 2, 5, 10, 20} %; Brier per barrier level. A model claiming 5 % that
  delivers 12 % is worse than useless to a seller regardless of its discrimination.
- **Economic:** simulated P&L of selling `K⁺(α)` / `K⁻(α)` strikes, net of Delta Exchange
  fees (`min(0.03 % notional, 10 % of premium)` per leg, per `DAILY_EXPIRY_ALPHA.md`),
  against fixed-width and RANGER-chosen strikes. Reported with CVaR and worst-case, not just
  mean.
- **Significance:** Diebold–Mariano with HAC errors, moving-block bootstrap, and a **Model
  Confidence Set** so we never claim a win that a multiple-comparison correction erases.

### 6.4 Ablations (each isolates one design claim)

1. Remove clock anchoring → quantifies the (demoted) §2.4(iii) clock effect.
2. Remove the multi-anchor augmentation → quantifies the §3.4 trick.
   1b. Remove day-of-week/weekend features → quantifies the dominant calendar signal.
3. Remove the Log-HAR base (pure MLP) → shows the residual structure earns its place.
4. Remove semivariance/jump features → tests the Patton–Sheppard channel.
5. Remove Stage-A/Stage-B factorization (predict `M⁺` directly) → tests the invariance prior.
6. Remove calibration layer → quantifies how much Stage C matters economically.

### 6.5 Failure conditions we commit to reporting

The project is **not** declared successful if any of these hold, and they will be reported
either way:

- Does not beat Log-HAR on QLIKE out-of-sample.
- Barrier calibration error exceeds 2 pp at α = 5 %.
- Economic edge vanishes after fees.
- Performance is confined to the pre-ETF regime.

---

## 7. Deployment

Target: **Hugging Face Space, free tier, 2 vCPU / 16 GB.**

- `predict.py` — pure NumPy forward pass from exported weights (no PyTorch at inference), so
  the Space image stays small and cold-starts fast.
- FastAPI/Gradio app serving `/api/kronos`-**compatible** JSON, so `src/data.js` keeps
  working unchanged, plus a richer `/api/noctua` carrying the full survival curves and safe
  strikes.
- Backwards compatibility: emit `upside` and `volAmp` in the legacy shape — `upside` from
  `P(R > 0)`, `volAmp` from `P(RV > trailing RV)` — so the dead Kronos scrape is replaced
  with no dashboard changes required.
- Live candle input via the sources the dashboard already uses.
- Nightly cron refresh at 17:00 UTC.

---

## 8. Constraints and honest limitations of this build environment

Stated up front because they shape what can be verified here:

1. **Egress is restricted.** The session's proxy permits GitHub and PyPI; it blocks Binance,
   Deribit, Coinbase, Kraken, CoinGecko, CryptoCompare, **and `huggingface.co`**. Data is
   therefore sourced from a GitHub-hosted mirror (§3.1), which is why Bitstamp rather than
   Binance is the primary series.
2. **Kronos cannot be executed here** (weights live on the blocked host). The head-to-head
   benchmark is written and shipped but must be run in an environment with HF access. Until
   it is, **no claim of superiority over Kronos is empirically established by this repo** —
   only the structural arguments of §2.2, the compute/variance arithmetic, and the published
   result of §2.3. This will be stated plainly in the README rather than glossed.
3. **No implied-volatility history.** Deribit is blocked, so DVOL/IV series are unavailable
   here. The model predicts *realized* quantities, which is well-posed on its own; the
   rich/cheap comparison against implied is left to the live dashboard, which already fetches
   Deribit client-side.
4. **Single-venue price data.** Cross-venue wick validation (§3.5) is limited to whatever
   second source can be mirrored through GitHub.
5. **No paid compute.** HF Jobs requires credits this account does not have; all training
   runs on this container's 4 CPU cores. This is a real constraint on model size — and also
   a genuine demonstration that the approach is cheap.

---

## 9. Work plan

| # | Stage | Output |
|---|---|---|
| 1 | Data ingestion, cleaning, cross-venue wick validation | `data/` parquet, integrity report |
| 2 | Episode builder: multi-anchor windows + all five labels | labelled episode table |
| 3 | Feature engineering: HAR cascade, semivariance, jumps, range, clock | feature matrix + leakage audit |
| 4 | Baselines: Log-HAR, HAR, HARQ, HAR-RS, EWMA, GARCH, reflection-principle barrier | baseline scoreboard |
| 5 | NOCTUA Stages A/B/C | trained model, < 1 M params |
| 6 | Walk-forward evaluation, ablations, significance testing | results tables + reliability diagrams |
| 7 | Cross-instrument and null/surrogate hallucination tests | robustness report |
| 8 | NumPy export, HF Space app, dashboard wiring | deployable artifact |
| 9 | Findings write-up, including negative results | `RESULTS.md` |

---

## 10. Scientific commitments

1. **No lookahead.** Every feature at `τ` uses only data strictly before `τ`. A leakage audit
   is a deliverable, not an afterthought.
2. **Proper scoring rules only.**
3. **Calibration before discrimination.** A sharp but miscalibrated tail probability is a
   trap for a seller.
4. **The baseline is Log-HAR, not a random walk.**
5. **Negative results are published.** If the residual network does not beat Log-HAR, the
   README will say so and the model will ship as a well-calibrated Log-HAR with a barrier
   layer — which is still a strict improvement on scraping a dead page.
6. **Nothing here is financial advice.** The failure mode of a short-option strategy is a
   rare, large loss; every result is reported with tails, not just means.

---

*Educational and research use only. Not financial advice.*
