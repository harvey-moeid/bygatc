# NOCTUA-BENCH — results

Walk-forward, 6 expanding folds (2021–2026), embargoed splits, production
slice only (19 h window opened 17:00 UTC, one non-overlapping episode per day).
Every competitor is refit inside each fold. Reproduce with:

```
python -m model.eval.benchmark      # proper scores + CORP + Christoffersen
python -m model.eval.falsify        # is it reasoning or pattern-matching?
python -m model.eval.synthetic      # instruments with a known right answer
python -m model.eval.regimes        # conditional calibration, real BTC, OOS
```

---

## 0. The benchmark caught its own author first

The metric this project had been quoting — **mean |coverage error|** — is
cheatable, and here is the proof, from the benchmark's own table:

| model | mean coverage error, pp |
|---|---|
| **scaled_clim** (unconditional shape × trailing vol) | **1.360** ← *wins* |
| noctua_v2 | 1.629 |
| climatology (constant, input-blind) | 2.493 |
| noctua_shuffled (features scrambled) | 2.969 |
| log_har_gauss | 3.332 |
| persistence | 3.855 |

A near-trivial baseline **beats the shipped model**, and a constant that
ignores every input beats both real econometric competitors. Marginal coverage
is what an unconditional distribution is *fitted to*, so scoring it rewards
having fitted an intercept. The 1.629 pp figure quoted throughout `RESULTS_V2.md`
should be read as a calibration diagnostic and never as evidence of skill.

Everything below is a strictly proper score or a falsification test.

---

## 1. Strictly proper scores

Lower is better. A proper score charges jointly for calibration **and**
sharpness, so calibration alone cannot win one.

| model | pinball | CRPS | Brier | log score |
|---|---|---|---|---|
| **noctua_v2** | **0.003633** | **0.005307** | 0.180584 | **0.529089** |
| log_har_gauss | 0.003785 | 0.005344 | **0.180476** | 0.533638 |
| scaled_clim | 0.003803 | 0.005498 | 0.182808 | 0.538220 |
| persistence | 0.003945 | 0.005570 | 0.183798 | 0.547539 |
| climatology | 0.004109 | 0.005910 | 0.189167 | 0.555597 |
| noctua_shuffled | 0.004269 | 0.006099 | 0.191451 | 0.563156 |

NOCTUA wins pinball, CRPS and log score — the three that grade the **whole
predictive distribution**. On Brier over the fixed binary barrier events it is
level with `log_har_gauss` (0.180584 vs 0.180476, a 0.06 % gap).

Volatility QLIKE: **noctua 0.2998**, log_har 0.3145, persistence 0.4474.

---

## 2. CORP decomposition — the part that cannot be faked

`S = MCB − DSC + UNC` via isotonic recalibration
(Dimitriadis, Gneiting & Jordan, *PNAS* 2021). **DSC is 0 by construction for
any constant forecaster**, so it cannot be reached without genuine conditional
information.

| model | DSC (higher better) | MCB (lower better) |
|---|---|---|
| log_har_gauss | **0.008707** | 0.024737 |
| scaled_clim | 0.008362 | 0.026725 |
| **noctua_v2** | 0.008178 | **0.024317** |
| persistence | 0.007307 | 0.026659 |
| noctua_shuffled | 0.000913 | 0.027919 |
| **climatology** | **0.000000** | 0.024721 |

Two things to read here, and the second is not flattering.

**The benchmark is sound.** Climatology scores DSC = 0.000000 exactly, and
`noctua_shuffled` — the real model reading a *random other episode's* features,
identical marginals, destroyed alignment — collapses to 0.000913. Skill shows
up in this column or it does not exist.

**NOCTUA does not win it.** Its discrimination is marginally *below*
`log_har_gauss` (0.008178 vs 0.008707, ~6 % of the DSC level). NOCTUA instead
posts the **lowest miscalibration of any competitor**. So on binary barrier
events the committee is buying calibration at a small cost in sharpness, and
against a plain Log-HAR + Gaussian first-passage baseline it is **effectively
tied, not ahead**. With 6 folds I did not establish that the 6 % gap is
distinguishable from noise in either direction, and it should not be quoted as
if it were.

The honest summary: NOCTUA's advantage is real on the **full distribution**
(pinball, CRPS, log score) and on **volatility** (QLIKE), and is **absent on
binary barrier discrimination**.

---

## 3. Conditional coverage (Christoffersen 1998), α = 5 %

| side | hit rate | p(uncond.) | p(independence) | p(joint) |
|---|---|---|---|---|
| up | 4.90 % | 0.256 | 0.477 | 0.311 |
| down | 7.04 % | 0.360 | 0.721 | 0.332 |

No rejection anywhere. Independence matters most: breaches do **not cluster**,
so the model is genuinely adapting to state rather than carrying a fixed level
through calm and violent weeks alike. (Contrast the synthetic control in
`eval/benchmark.py`, where clustered breaches sail through unconditional
coverage at p = 0.72 and independence rejects at p = 0.0000.)

---

## 4. Is it reasoning, or pattern-matching?

All checks in `eval/falsify.py` pass.

- **Monotone response.** σ is *strictly* increasing in trailing volatility
  across a 13-point sweep, elasticity **d log σ / d log vol = 0.889** — near
  proportional with mild shrinkage toward the mean, which is the economically
  correct behaviour. A model that had learned a correlation rather than the
  mechanism would not be forced to get this right.
- **Sharpness.** The α = 5 % level has CV **0.197** and a **2.24×** spread
  across episodes. A lookup table sits at 0 and 1.00×.
- **Feature use.** 37 of 39 features move the forecast; only `reg_post_etf`
  and `cal_H` are inert. `har_1d` dominates (22.1 % σ shift), with
  `cal_weekend_frac` (4.3 %) and `cal_dow_sin` (3.7 %) next — calendar
  structure outranks the longer HAR components.
- **Off-distribution.** At 20×, 400× and 1/400× training volatility the output
  stays finite, monotone, positive and in range. It does not produce confident
  nonsense where it has no data.

## 5. Instruments with a known right answer

`eval/synthetic.py` feeds processes whose true barrier law is exact (driftless
GBM: `P(max ≥ u) = 2Φ(−u/σ)`) or Monte-Carlo-precise (GARCH(1,1), Merton jump
diffusion). NOCTUA has only ever seen Bitcoin.

| instrument | true σ | model σ | ratio |
|---|---|---|---|
| GBM 1 % | 1.000 % | 1.049 % | 1.049 |
| GBM 3 % | 3.000 % | 2.867 % | 0.956 |
| GBM 9 % | 9.000 % | 8.109 % | 0.901 |
| GARCH(1,1) | 3.000 % | 2.837 % | 0.946 |
| jump diffusion | 2.317 % | 2.171 % | 0.937 |

**Across a 9× volatility range it has never seen, σ is recovered to a 1.16×
spread.** It is measuring volatility from the series, not recalling Bitcoin's.

Touch probabilities run *conservative* — model/true ratios 1.00–1.24 at
σ ≥ 3 % — which is the safe direction. The exception is genuine: at σ = 1 %
(below anything in Bitcoin's history) it puts 12.8 % on a 2 % barrier where
Gaussian truth is 4.6 %. It imposes a crypto-like fat tail on a thin-tailed
instrument. Correct for its actual deployment, wrong in general, and worth
knowing before pointing it at anything but BTC.

---

## 6. What this found, and the fix

Marginal calibration was concealing a real defect. Out of sample from
2024-07, realized vol lands **below** the forecast **66.4 %** of the time,
median ratio **0.874**. Every barrier scales with σ, so strikes were quoted too
far out — safe, but forfeiting premium every night, with breach rates near half
of nominal.

It is **not a fixed constant**:

| split | median RV/σ | fraction below |
|---|---|---|
| train | 0.970 | 55.0 % |
| calib | 1.009 | 48.6 % ← essentially unbiased |
| test | 0.874 | 66.4 % ← biased |

A correction fitted on calib would be 1.01 and do nothing. One fitted on test
would be look-ahead — fitting the evaluation data, precisely the cheat this
benchmark exists to catch. The bias is a **regime property**, so the correction
must move with the regime.

`serve/adaptive.py` estimates it from episodes that have already **settled**
strictly before the anchor — causal by construction, median rather than mean
because the ratio is right-skewed, clipped to [0.70, 1.40] so a data fault
cannot masquerade as a regime shift.

| | before | after |
|---|---|---|
| median RV/σ (test era) | 0.874 | **0.990** |
| fraction below | 66.4 % | **51.5 %** |
| barrier calibration | 2.073 pp | **1.373 pp** |

On the calibration split the factor comes out at **1.011** — it correctly does
nothing where the model was already unbiased. That self-cancelling behaviour is
the point: this is insurance against regime change, not a tuning knob. Windows
of 30/60/90/180 days all land within 0.98–0.99, so the horizon is not fitted to
the answer. Lag-1 autocorrelation of the episode-level ratio is −0.021 —
individual nights are unpredictable and no attempt is made to predict them;
only the drifting *level* is tracked.

---

## 6b. The training defect, and the one change that fixed it

Sections 1–2 say NOCTUA wins the full predictive distribution and is *behind*
`log_har_gauss` on binary barrier discrimination. That gap had a cause in the
training setup, not in the features.

**Stage B was trained on an easier problem than it faces.** It learns quantiles
of `M_up/sigma` conditioned on `log sigma`, and in training `sigma` was `RV` —
the *realized* window volatility. At serving it is the model's own forecast.
Dividing by the realized value removes the volatility-forecast error from the
training problem but not from the deployed one:

| | sd |
|---|---|
| `M_up / RV_true` — what training fitted | 0.5490 |
| `M_up / sigma_served` — what serving faces | 0.9312 |

Stage B was fitted to a distribution 40 % narrower than the one its output is
applied to. Worse, `RV` sat in the target's *denominator* and in the
*conditioner*, so noise in `RV` alone manufactures dependence: permuting `RV`,
which destroys every economic relationship it has with `M_up`, still leaves
Spearman −0.4331 against −0.0556 actually observed. The arithmetic artifact was
larger than the real relationship (Pearson's spurious correlation of ratios,
1897).

**The fix** retargets stage B onto a volatility reference that is causal by
construction: `exp(har_1d) * sqrt(H)`, where `har_1d` is a feature built from
bars strictly before the anchor. Nothing is fitted, so nothing can leak; clip
bounds come from each fold's training episodes only. It lands at sd 0.9272
against the 0.9312 serving faces — and it is a *weaker* forecast than the
deployed one, which makes the arm conservative.

Six walk-forward folds, three seeds, identical in every other respect:

| arm | DSC/UNC | vs base | folds won | t-like | pinball | CRPS | QLIKE |
|---|---|---|---|---|---|---|---|
| baseline | 0.04980 | — | — | — | 0.003633 | 0.005307 | 0.2998 |
| **serve_consistent** | **0.05382** | **+8.1 %** | **6/6** | **+3.78** | **0.003594** | **0.005277** | 0.2996 |
| uniqueness | 0.04981 | +0.0 % | 3/6 | +0.80 | 0.003633 | 0.005307 | 0.2998 |
| nonoverlap | 0.04493 | −9.8 % | 0/6 | −3.90 | 0.003734 | 0.005477 | 0.2953 |

Discrimination improves in **every fold**, and pinball (5/6) and CRPS (5/6)
improve with it, so this is not discrimination bought by wrecking the
distribution. QLIKE is unchanged, as expected — the change is to stage B.

**What this does NOT establish.** It does not put NOCTUA ahead of
`log_har_gauss`. The +8.1 % is against our own baseline; against log_har the
correct paired statistic is **4/6 folds, mean +0.00083, t-like +0.46** — noise,
with one fold at −13.4 %. The honest reading is that the gap *closed*: baseline
won 1 of 6 folds against log_har at mean −0.00318, serve_consistent wins 4 of 6
at mean +0.00083. Behind → level. Not ahead.

**Two arms that did not work, both informative.**

*uniqueness* is **provably vacuous here**, not an experimental null. Our
episodes sit on a complete regular grid — every hour, every horizon — so
concurrency is a constant of the grid (61), average uniqueness is exactly 1/61
on the training split, and the normalised multiplier is 1.0000 to machine
precision. Measured, it moves DSC/UNC by ~1e-5 against the ~4e-3 that
`serve_consistent` moves — about 100× smaller and not in a consistent direction
(3 folds up, 3 down), i.e. effectively equivalent rather than exactly equal.
López de Prado's uniqueness weighting is built for *event-driven* labels with
data-dependent holding periods; on a regular grid there is nothing for it to
grip. The 60.9× redundancy (8,380 effective observations from 510,496 episodes)
is real and must be attacked by removing samples or shrinking capacity, not by
reweighting.

*nonoverlap* — training only on the 4,965 non-overlapping episodes — is worse
in **0/6 folds won**, −9.8 % DSC/UNC, and worse on pinball and CRPS. The 100×
overlapping augmentation is genuinely buying barrier discrimination and
distribution shape. It does slightly improve QLIKE (0.2953), so the redundancy
does cost something on the volatility level, but not enough to justify the
trade.

**Checked at the deployment configuration before shipping.** Walk-forward is
six refits; the deployed model is one fit applied to 2024-07 onward, so the two
can disagree. On that single split the raw model gains less (DSC/UNC +1.2 %)
and its raw coverage error gets *worse* (2.073 → 2.593 pp). That regression is
entirely a level effect, and `serve/adaptive.py` — which always runs in
production — absorbs it:

| | raw coverage | after the adaptive correction |
|---|---|---|
| old (trained on RV) | 2.073 pp | 1.360 pp |
| **new (causal reference)** | 2.593 pp | **1.284 pp** |

So as actually deployed the new artifact is better on discrimination *and* on
coverage (−5.6 %), with QLIKE unchanged. Shipped: `train_v2.py` now trains
stage B against the causal reference and the artifact records
`stage_b_sigma_ref: causal_har_1d_clipped`.

**A packaging bug this surfaced.** `train_v2` recorded
`"feat_cols": list(X.columns)` — correct only while every column in
features.parquet was a model input. Adding the `eff_*` research columns made
the artifact declare 42 inputs while its weights expected 39, and serving died
with a matmul dimension error. `prepare()` now returns the columns it actually
consumed and the artifact records those. The research columns were added
several commits earlier and the mismatch was invisible until the artifact was
next rebuilt.

**An earlier version of this result was discarded.** The first cross-fitted
reference used ordinary K-fold, fitting each held-out block on every *other*
block including later ones — not causal for a time series, so a 2021 training
episode's sigma was computed partly from 2025 data. That run was 5/6 positive
and is not reported. Caught in review; the replacement fits nothing at all.

---

## 6c. Training on other crypto: volatility transfers, barrier shape does not

The question the 3300-day harvest existed to answer. BTC, ETH, LTC and XRP all
reach back to 2017-08-02, so altcoin episodes pass through the *same*
`splits.time_splits` boundaries as BTC's and contribute genuine pre-`TRAIN_END`
training data. SOL is **excluded from training**: it lists later (899 days, all
of it inside BTC's test era) and pooling it would reintroduce exactly the
contemporaneous cross-sectional leak the long harvest was run to avoid.

Test and calib slices are forced BTC-only in both arms — adding assets must be
judged on the instrument that ships, not on a pool average a strong altcoin
could carry.

| metric | BTC-only | pooled | folds won | t-like |
|---|---|---|---|---|
| DSC/UNC | 0.049802 | 0.048905 | 2/6 | −0.94 |
| pinball | 0.003633 | 0.003627 | 5/6 | +0.77 |
| CRPS | 0.005307 | 0.005312 | 3/6 | −0.51 |
| **QLIKE** | **0.299840** | **0.294241** | **5/6** | **+1.63** |

**Volatility improves in 5 of 6 folds, 1.87 %.** Barrier discrimination does
not move and if anything drifts negative: 2/6 and a t-like of −0.94, with fold
swings (−6.6 % to +5.3 %) dwarfing the −1.8 %. CRPS flat.

A note on what "1.87 %" is, because the two available averages differ and the
larger one is the one quoted. Every percentage in this section is a ratio of
the columns above, i.e. of fold-AVERAGED scores. Averaging the six per-fold
percentages instead gives **1.45 %** for QLIKE — smaller, because a ratio of
means weights each fold by its own QLIKE level, and the levels line up with
the effect: the fold pooling helps most is the highest-QLIKE one (2023, 0.435,
−4.9 %) and the one fold it HURTS is the lowest (2026, 0.204, +1.3 %). For DSC/UNC
the two agree (−1.80 % vs −2.00 %). Neither convention changes the direction
of anything here, and both are reported so the reader can pick.

**These numbers are WEAKER than the ones first published here, and the reason
matters more than the numbers.** The first version of this section reported
QLIKE 6/6, 2.69 %, t-like +2.74. It was computed before the ETH gap filter
existed, i.e. with 2,924 mislabelled episodes in the pooled arm. Review caught
the gap; refiltering and re-running gives 5/6, 1.87 %, t-like +1.63. Both
figures are ratios of fold-averaged QLIKE, so the comparison is like for like;
under the per-fold average the same pair reads 2.42 % → 1.45 %.

I predicted the opposite. The commit that added the filter argued that
stretched windows inflate RV, so the defect must have biased *against* pooling
and "the re-run confirms rather than rescues the result". It did not: it
weakened it, on five of six folds, and fold 2026 flipped sign entirely
(−1.7 % → +1.3 %). The mechanism reasoning was plausible and untested, which is
the same habit that produced the venue-cap error earlier in this file.

At t-like +1.63 on n = 6 this is a modest effect, not a strong one, and it
should be read that way.

| fold | n_train BTC → pooled | DSC/UNC | QLIKE |
|---|---|---|---|
| 2021 | 102,087 → 301,821 | −5.2 % | −0.9 % |
| 2022 | 137,127 → 441,421 | +1.5 % | −2.6 % |
| 2023 | 172,167 → 581,520 | −4.2 % | −4.9 % |
| 2024 | 207,207 → 721,477 | −2.7 % | −0.6 % |
| 2025 | 242,343 → 861,895 | +5.3 % | −1.0 % |
| 2026 | 277,383 → 1,001,925 | −6.6 % | **+1.3 %** |

The split is mechanically sensible rather than surprising. Crypto volatility is
strongly correlated across assets, so 845,000 extra episodes sharpen the
volatility cascade. Excursion *shape* — how far a path travels per unit of
realized vol — reflects each asset's own microstructure, liquidity and tick
size, so pooling it adds variance without adding signal. That is the same
boundary `eval/cross_asset.py` found from the other direction: σ transfers
zero-shot to unseen altcoins, and the excursion shape is where transfer gets
shakier.

### Does the gain depend on the expiry? Yes — and it is gone by H = 19

Scored through `run_fold` with `prod_override`, one horizon at a time, so every
figure comes from the same committee, both barriers and the same grid as the
aggregate above. One train/test split, not six folds.

| H | n | QLIKE BTC | QLIKE pooled | Δ | DSC/UNC BTC | DSC/UNC pooled | Δ |
|---|---|---|---|---|---|---|---|
| 6 | 770 | 0.3673 | 0.3553 | **−3.3 %** | 0.08341 | 0.08146 | −2.3 % |
| 12 | 769 | 0.2884 | 0.2858 | −0.9 % | 0.04565 | 0.04535 | −0.6 % |
| **19** | 769 | 0.2478 | 0.2509 | **+1.2 %** | 0.03957 | 0.03830 | −3.2 % |
| 24 | 769 | 0.2361 | 0.2373 | +0.5 % | 0.03830 | 0.03698 | −3.5 % |

**The volatility gain is a short-horizon effect.** −3.3 % at H = 6, decaying
through −0.9 % at H = 12, and *negative* by the deployed H = 19. Discrimination
is negative at every horizon. Both survived the ETH gap fix and the switch to
committee scoring, so neither is an artifact of the two defects this section
has already had.

That is a sharper reason not to ship pooling than the aggregate gave. The
aggregate said "helps a metric the product does not optimise"; this says the
help is not even present at the expiry the product is sold at.

**The H = 19 sign flip persists, and now means something narrower.** This table
says +1.2 % worse at H = 19; the six-fold walk-forward, which scores H = 19 and
nothing else, says 1.87 % better in 5 of 6 folds. Fixing the estimator removed
the *DSC* half of that discrepancy — the old table's DSC column was the neural
head alone on upside barriers, and its H = 6 baseline read 0.12641 against
0.08341 here, a 34 % difference — but the QLIKE half is unchanged. So the
original attribution stands for QLIKE: one split of ~770 episodes cannot
resolve a 1–2 % difference that six refits can. Six folds beat one, and the
walk-forward remains the measurement.

**Not shipped.** The deployed product is a barrier forecast, and pooling does
not improve barrier discrimination — and the QLIKE gain that survives the gap
fix is concentrated at horizons shorter than the one that ships. A 1.9 % gain
at H = 19 would be worth arguing about for a volatility product; +1.2 % in the
wrong direction there does not justify tripling the training set and adding
three assets' data-quality risk to a model whose output is a touch
probability. Recorded as a modest, replicated effect on the wrong metric, at
the wrong expiry.

---

## 7. Where this leaves the model

**Established.** It carries genuine conditional information (DSC ≫ 0, and
shuffling the features destroys it). It beats every baseline on the full
predictive distribution and on volatility. It responds correctly and
monotonically to its causal driver. It does not break off-distribution. It
recovers σ on processes it has never seen. Breaches do not cluster.

**Not established.** That it beats a competent classical baseline on *binary
barrier discrimination* — there it is tied with Log-HAR + Gaussian, and by DSC
marginally behind. The committee's contribution is calibration and distribution
shape, not sharper event prediction.

**Measured, but only as compute.** The Kronos head-to-head has not produced
accuracy numbers, but one hard figure did come out of trying. Running
Kronos-small on a CPU runner over this project's own production episodes --
512-hour context, 19-hour horizon, 32 sampled paths -- costs

    117.4 seconds per episode

and it is remarkably steady: 117.36 s at episode 1, 117.37 s at episode 161,
across five and a half hours. NOCTUA answers the same question in 0.6 ms.
That is a factor of roughly **196,000**, against a parameter ratio of 1,300
(24.7 M vs 19,134), because Kronos must autoregressively generate 32 paths
while NOCTUA evaluates four matmuls and a cumulative sum.

None of that says which model is more ACCURATE, and it must not be read that
way. It does bound what is deployable on a free 2-vCPU Space: at 117 s per
forecast with a 30-minute refresh, Kronos-small would spend 6.5% of its life
computing one number.

**Measured at last.** Kronos-small, 120 production episodes, 32 independent
sampled paths each, same anchors, same barriers, graded by one implementation
of one set of rules.

| model | Brier | log score | DSC ↑ | MCB ↓ |
|---|---|---|---|---|
| **noctua_v2** | **0.145176** | **0.440193** | **0.018148** | **0.023733** |
| kronos-small | 0.211059 | 0.651811 | 0.005683 | 0.077150 |
| climatology | *0.139591* | *0.428622* | 0.000000 | 0.000000 |

**It replicated, by accident.** Two Kronos runs finished independently — one on
this branch, one on `main` — 119 of their 120 anchors shared, neither aware of
the other. Agreement across two separate Monte-Carlo samplings:

| | σ/RV | noctua Brier | kronos Brier | noctua DSC | kronos DSC |
|---|---|---|---|---|---|
| run A | 1.172 | 0.146371 | 0.214208 | 0.018334 | 0.006580 |
| run B | 1.184 | 0.145176 | 0.211059 | 0.018148 | 0.005683 |

Same ordering, same margins to within a few percent. The table above reports
run B, which is the file on `main`.

NOCTUA wins Brier, log score and discrimination. Paired episode-level bootstrap
(2,000 resamples over the 120 episodes, which preserves the within-episode
dependence between barriers and sides):

    Brier advantage to NOCTUA   +0.0504 .. +0.0868    P(better) = 1.000
    DSC   advantage to NOCTUA   +0.0055 .. +0.0202    P(better) = 1.000

Both intervals exclude zero. Against a model **1,291× larger** (24.7 M
parameters against 19,134), on the task this repo was built for.

Four things must be said alongside that, because none of them flatters us.

**Climatology's Brier and log score are the lowest in the table and are
IN-SAMPLE.** Its base rate is estimated from the evaluation set itself, so those
two columns are not a fair comparison and neither model "loses" to it.

**And `DSC = 0` from climatology is a WEAKER control than it looks.** A constant
forecaster is pinned to zero by construction, so it cannot detect
discrimination manufactured by the scorer. CORP fits its isotonic regression on
the same 120 outcomes it then scores, so ANY forecaster with variation collects
some DSC from that in-sample fit — including one whose ordering is pure noise.
The control that actually measures this keeps each model's marginal forecast
distribution and destroys only its alignment with outcomes:

| model | real DSC | shuffled mean | shuffled p95 | clears the floor? |
|---|---|---|---|---|
| noctua_v2 | 0.018148 | 0.005096 | 0.008546 | **yes** |
| kronos-small | 0.005683 | 0.003722 | 0.006238 | **no** |

The isotonic manufactures DSC of roughly 0.004–0.006 out of noise alone.

**Kronos is genuinely better calibrated on the volatility LEVEL.** Median
predicted/realized: Kronos **1.172**, NOCTUA **1.232**. Both over-forecast; the
24.7 M-parameter general-purpose model is closer to unbiased than the
purpose-built one. That is a real result and it is not softened here.

**RETRACTED: "Kronos carries real conditional information."** An earlier
version of this section said exactly that, on the strength of DSC 0.0057–0.0066
being "not zero and not close to it". It does not survive the shuffled control
above: Kronos's DSC falls INSIDE the noise band the in-sample isotonic produces
from randomly-ordered predictions (p95 = 0.006238). On this evidence Kronos's
barrier discrimination is **not distinguishable from zero**, and the honest
statement is that 120 episodes cannot resolve it either way — not that it is
absent. NOCTUA's DSC clears the same floor by a wide margin.

Kronos's miscalibration is separately large and is measurable: MCB 0.077150,
3.3× NOCTUA's, which is what you would expect from sampled paths never fitted
to this question.

**Three earlier runs were invalid, and two of those were our fault.** Run 1
used `top_p=0.9`, whose nucleus truncation removes exactly the tail where large
moves live. Runs 1 and 2 both then hit a worse defect:
`KronosPredictor.predict(sample_count=32)` **averages** its draws
(`kronos.py:467`) and returns one smoothed path, so `n_paths` was 1, every
"probability" was exactly 0.0 or 1.0, and the sampled volatility ratio read
0.259 and 0.373. That reads as "Kronos is 2.7× too calm" and it is not — with
genuine sampling the ratio is **1.172**. Publishing the earlier number would
have been a false claim about someone else's model, produced by our harness and
flattering to ours. `eval/kronos_ci.py` now draws via `predict_batch` and
`assert_ensemble()` aborts on episode 1 rather than 120.

A fourth run was lost to plumbing rather than science: the compute succeeded and
the commit step failed, and the predictions were recovered from the Actions
artifact by `recover-kronos-artifact.yml` rather than paying 3h49m again.

**Compute.** 114.2 s/episode for Kronos against 0.6 ms for NOCTUA — a factor of
roughly 190,000, against a parameter ratio of 1,291.

**Scope.** 120 daily non-overlapping episodes from one asset over one four-month
window, against Kronos-**small**. It is not a claim about Kronos-base, about
other horizons, or about other instruments.

Getting Kronos to run at all took moving it into CI: `huggingface.co` weight
downloads are blocked from the development environment (HTTP 403 via the proxy);
only metadata is reachable, which confirms Kronos-small at 24.7 M parameters and
Kronos-base at 102.3 M against NOCTUA's 19,134 — roughly 1,300× and 5,300×
larger — but says nothing about accuracy.

Run 1 was invalid for an honest reason: `top_p=0.9` truncates the token
distribution exactly where large moves live, and the sampled paths came out at
0.377 % volatility against 1.467 % realized.

Run 2 was invalid because of **a bug in this repo**. `KronosPredictor.predict(
sample_count=32)` does not return 32 paths — it averages them internally
(`kronos.py:467`; the `predict_batch` docstring says "automatically averaged
internally") and returns one smoothed path. So:

| | run 1 | run 2 | what it actually was |
|---|---|---|---|
| sampled σ / realized RV | 0.259 | 0.373 | the average of 32 paths, not Kronos's σ |
| paths per episode | 1 | 1 | asked for 32 |
| touch probabilities | {0, 1} | {0, 1} | an indicator on the mean path |

The tempting read of run 2 — *"Kronos under-states volatility by 2.7×"* — is
false, and it is the kind of claim that is easy to publish because it flatters
the model doing the measuring. Scoring those 0/1 indicators against NOCTUA's
calibrated curve would have compared a probability forecast to a point forecast
and called the result a win.

`eval/kronos_ci.py` now draws paths via `predict_batch` with the context
repeated and `sample_count=1`, which returns each rollout intact at unchanged
compute, and `assert_ensemble()` aborts in the first episode — not the last —
if the ensemble is ever collapsed again. Until that run lands, every claim in
this repo is against Log-HAR and the baselines above, which is the harder
comparison, and **none of them is a measurement of Kronos**.

*Educational research only. Not financial advice.*
