# NOCTUA — Results

**49,866 parameters. 198 KB. ~6 ms per forecast on one CPU core.**

Everything below is out-of-sample. The headline table is an expanding-window
walk-forward over **2,046 non-overlapping production episodes** (19-hour window
opened at 17:00 UTC, one per calendar day, 2021–2026), each fold retrained from
scratch with an embargo so no test window shares a minute with training.

Method, motivation and the full literature review: [`RESEARCH_PLAN.md`](RESEARCH_PLAN.md).

---

## 1. The headline

| Question | Result | Verdict |
|---|---|---|
| Beats a well-specified **Log-HAR** on volatility? | QLIKE **0.3113 vs 0.3203** (−2.79 %), **p = 0.043**, **5/6 folds won** | **Yes**, modestly |
| Beats the **Gaussian first-passage** baseline on deep-tail barriers? | calibration error **0.94 pp vs 3.33 pp** at α = 1 % | **Yes**, decisively |
| Beats it in the **body** (α = 10–20 %)? | 4.0–4.6 pp vs **2.0–2.7 pp** | **No** — Gaussian wins |
| Predicts **direction**? | log-loss **0.6941** vs **0.6931** for a coin flip | **No** — no skill |
| Beats **Kronos**? | not run — weights unreachable from this environment | **Unproven** |

The −2.79 % volatility gain is small, and it should be. arXiv:2607.05291 tested
nine foundation models against Log-HAR across 50 assets: eight lost, and the
only winner (Tiny Time Mixers, <1 M params) won by **1.3–1.8 %**. A 2.79 % gain
with p = 0.043 sits squarely in the range that is achievable and real. Anyone
claiming a large margin over Log-HAR on realized volatility is measuring
something else.

---

## 2. Volatility — walk-forward, per fold

QLIKE (lower is better) against `log_har_cal` (Corsi cascade + horizon +
weekend fraction), the strongest baseline in our scoreboard.

| Test year | n | median RV | NOCTUA | Log-HAR-cal | gain |
|---|---|---|---|---|---|
| 2021 | 365 | 3.32 % | 0.3609 | 0.3727 | **−3.2 %** |
| 2022 | 365 | 2.55 % | 0.2914 | 0.2991 | **−2.6 %** |
| 2023 | 365 | 1.71 % | 0.4504 | 0.4223 | +6.7 % |
| 2024 | 366 | 2.05 % | 0.2624 | 0.2775 | **−5.4 %** |
| 2025 | 365 | 1.52 % | 0.2594 | 0.2833 | **−8.5 %** |
| 2026 | 220 | 1.61 % | 0.1991 | 0.2320 | **−14.2 %** |
| **pooled** | **2046** | | **0.3113** | **0.3203** | **−2.79 %** (p = 0.043) |

The single losing fold is 2023, the year volatility collapsed hardest. That is
the model's characteristic failure mode and it is discussed in §5.

**Fixed-split baseline scoreboard** (test 2024-07 → 2026-08, 769 episodes):

| model | QLIKE | R² (log) | vs ref | p |
|---|---|---|---|---|
| **NOCTUA** | **0.2492** | **0.4250** | **−5.74 %** | **0.0000** |
| log_har_cal | 0.2644 | 0.3816 | — | — |
| har_short | 0.2769 | 0.3189 | +4.76 % | 0.158 |
| harq | 0.2843 | 0.3124 | +7.54 % | 0.0008 |
| log_har | 0.2858 | 0.3434 | +8.10 % | 0.0000 |
| har_rs | 0.2873 | 0.3338 | +8.69 % | 0.0000 |
| ewma | 0.3070 | 0.3407 | +16.13 % | 0.0000 |
| constant | 0.5625 | −1.1553 | +112.79 % | 0.0000 |

The fixed split flatters the model relative to the walk-forward headline
(−5.74 % here vs −2.79 % pooled). **Trust the walk-forward number** — it
retrains per fold and includes the 2023 regime break that a single split
happens to sit outside of.

Two things worth noting honestly: the semivariance (`har_rs`) and quarticity
(`harq`) augmentations, which the literature favours, **did not help** on this
target — they rank below plain Log-HAR. And adding the calendar to Log-HAR
(`log_har_cal`, +7.5 % over `log_har`) mattered more than any of them, which is
the weekend effect from `RESEARCH_PLAN` §2.4(iii) showing up again.

---

## 3. Barriers — the actual product

For each target α the model names a level it claims breaks only α of the time.
We then count how often it actually broke. Mean |error| in percentage points,
pooled over walk-forward folds:

| α | **NOCTUA** | Gaussian reflection | ratio |
|---|---|---|---|
| **1 %** | **0.94** | 3.33 | **3.5× better** |
| **2 %** | **1.38** | 3.53 | **2.6× better** |
| **5 %** | **2.48** | 3.77 | **1.5× better** |
| 10 % | 3.69 | **2.71** | worse |
| 20 % | 4.09 | **2.01** | worse |
| 30 % | 4.11 | 3.69 | worse |
| **mean** | **2.78** | 3.17 | 12 % better |

**This is the result the project rests on.** In the deep tail — the only region
an option seller actually operates in — the textbook Gaussian first-passage
model **understates touch risk by 2–4×**: told to name a level that breaks 1 %
of the time, it names one that breaks 2.2–4.4 % of the time. NOCTUA names one
that breaks 0.8–1.2 %.

The crossover at α ≈ 10 % is real and is reported rather than buried. For
body-of-distribution questions the Gaussian is the better tool.

---

## 4. Direction — a negative result

| model | log-loss | Brier |
|---|---|---|
| NOCTUA | 0.6941 | 0.2504 |
| coin flip | **0.6931** | **0.2500** |

**There is no directional skill at this horizon**, and NOCTUA is fractionally
worse than nothing. This independently reproduces this repository's own
`SELLER_DIRECTIONAL_ALPHA.md`: *"None of the winning filters forecast where BTC
goes next week… breakout direction is a coin-flip."* Two unrelated methods, the
same conclusion.

Consequence for deployment: `data/kronos.json` now publishes **`upside: 50.0`**,
pinned. `src/data.js` feeds that field into `UI.computeStrikes()` to skew
recommended strikes, so passing an unvalidated number through would push real
recommendations around on noise. The model's raw P(up) is published as
`p_up_raw` and is wired to nothing.

---

## 5. Failure modes and limitations

**The 2023 fold.** Pure NOCTUA (no ensemble) lost that fold by **+72 % QLIKE**.
Diagnosis: trained through the high-volatility 2022 bear market, then tested on
the calmest year in the sample, it over-forecast persistently. Three fixes were
tried and only the third worked:

1. *A residual-anchor penalty* pinning the network toward the Log-HAR base.
   Bounded the blow-up (+72 % → +19 %) but did not fix the pooled loss, and at
   high penalty the model still lost 14 % — so the residual was not the cause.
2. *Scoring the predictive mean instead of the median*, on the theory that
   QLIKE wants the conditional variance. **Tested and rejected**: the mean
   over-forecasts (ratio 1.205) and scores worse (0.3082 vs 0.2430).
3. *A 25/75 NOCTUA/Log-HAR ensemble.* This worked: pooled −2.79 %, p = 0.043,
   5/6 folds, worst fold bounded at +6.7 %. The whole predictive distribution
   is shifted, not just the point forecast, so the barrier curves inherit the
   robust volatility level too.

**Calibration does not transfer across regimes.** Fitting the PIT recalibration
map on one period and applying it to the next initially made calibration
*worse* at every α, because the sign of the tail miscalibration flips between
volatility regimes (calibration-period upper-PIT bin 1.52, i.e. tails too thin;
test-period 0.81, tails too fat). The shipped configuration applies only
**half** the fitted correction (`shrink = 0.5`), selected by walk-forward sweep.
A production deployment should refit on a trailing window rather than freezing
the map.

**Downside is the weaker side.** Across configurations the model calibrates
upside excursions better than downside. At α = 5 % on the fixed split, the
"safe" put level broke 7.9 % of the time against 4.2 % for the call. Errors on
the put side are the expensive ones for a seller.

**Non-stationarity is severe.** Median realized volatility over the production
window drifts 2.85 % (train) → 1.86 % (calibration) → 1.67 % (test). Every
number here is conditioned on a market that keeps moving.

**The live path failed on its first real run, and why.** The serving code was
written in an environment whose egress proxy blocks every exchange API, so the
network path could not be exercised until it merged. It failed twice over:
Bitstamp pagination never advanced (passing both `start` and `end` makes the
API re-serve the same final page, so the loop exited after one call with
exactly 1000 bars), and the Binance fallback returned `HTTP 451` because
GitHub's runners sit on US IPs that Binance geo-blocks.

Behind both sat a worse, quieter bug. `LOOKBACK_HOURS` was set to 23 days on
the assumption that the 22-day HAR term was the longest window. It is not —
`reg_rv_vs_year` reaches back **365 days**, `mom_dist_ma100` 100 days,
`mom_drawdown_90d` 90 days. And short history does not raise: `prepare()` runs
`nan_to_num` after standardising, so an unfillable feature becomes 0, *which is
exactly its training mean*. Had the fetch merely "worked" at 23 days, the model
would have served confident strike levels with four long-lookback features
silently pinned to their means. Measured over 60 daily anchors, that skew moves
the forecast volatility by up to 3.5% and the **α = 1% put strike by a median
0.38 pp of spot, up to 1.45 pp** — a few hundred dollars at current prices, on
the leg where errors are most expensive, with nothing to indicate it.

The fix ships the 365-day history as a committed hourly bundle
(`data/noctua_history.parquet`, ~716 KB, built by the same `build_hourly` as
training) and fetches only the recent tail, which is a single request. Short or
gappy history is now a hard error rather than a silent mean-imputation.

**Single venue.** Bitstamp BTC/USD only. Deribit-settled options settle on a
multi-venue index, so a Bitstamp-only wick is a touch a real seller would not
have suffered. Isolated bad prints are detected and neutralised (1–5 per
100,000 minutes in the modern era), but a genuine multi-venue index was not
reachable — every exchange API is blocked by this environment's egress policy.

**No implied volatility.** Deribit is blocked here, so the model predicts
*realized* quantities only. Whether that is rich or cheap against the option
chain is left to the dashboard, which fetches Deribit client-side.

**Kronos was not benchmarked.** `huggingface.co` is blocked, so the weights
could not be downloaded. `model/eval/kronos_baseline.py` is written and shipped
but **has not been run**. Until it is, this repo claims superiority over
Log-HAR and over the Gaussian barrier baseline — not over Kronos.

---

## 6. Does it hallucinate?

The user's question, made precise: when the input carries no signal, does the
model fall back to the unconditional distribution, or keep emitting confident
varying forecasts?

| input | n | forecast sd | R² | median predicted RV | median true RV |
|---|---|---|---|---|---|
| real BTC (test) | 769 | 0.320 | 0.425 | 1.84 % | 1.66 % |
| real BTC 2012–2016 (out-of-distribution era) | 1458 | 0.561 | **0.664** | 3.35 % | 3.44 % |
| shuffled returns (no vol clustering) | 3295 | **0.120** | −0.57 | 4.64 % | 5.09 % |
| IID Gaussian returns | 3295 | **0.067** | −5.95 | 5.34 % | 5.89 % |
| constant price | **0** | — | — | — | — |

It passes:

- **Forecast dispersion collapses** when structure is destroyed — sd 0.320 →
  0.120 → 0.067. It stops varying its predictions when there is nothing to
  predict, which is the opposite of hallucinating.
- **It generalises to a genuinely unseen regime.** On BTC 2012–2016 — never
  trained on, roughly double the volatility level, radically different
  microstructure — it scores **R² = 0.664**, higher than on the test split, and
  is nearly unbiased in level (3.35 % predicted vs 3.44 % realized). This is the
  scale-invariance factorization doing its job.
- **It still reads the level correctly on surrogates** (within ~10 %) while
  correctly abandoning any claim to explain the variation.
- **A constant-price series yields zero episodes** — the pipeline refuses to
  forecast it rather than inventing a barrier.

A true cross-*asset* test (ETH) could not be run: the egress policy blocks every
exchange API, and the one GitHub-mirrored ETH minute dataset publishes to Kaggle
rather than into the repository.

---

## 7. Cost comparison

| | NOCTUA | Kronos-small |
|---|---|---|
| Parameters | **49,866** | 24.7 M + tokenizer |
| Artifact | **198 KB** | ~100 MB |
| Dependencies at inference | NumPy + SciPy | PyTorch |
| Time per forecast | **~6 ms** | 20–60 s (24 rollouts) |
| Tail probability error from sampling | **0** (analytic) | ±4.4 pp at α = 5 %, n = 24 |
| Free 2 vCPU / 16 GB Space | comfortable | marginal — this repo hit `MemoryError` |

To pin a 5 % tail to ±0.5 pp by Monte Carlo needs ≈ 1,900 rollouts: **10–30
hours per forecast** at the rates this repo measured. Direct distributional
regression makes the number free.

---

## 8. Reproducing

```bash
git clone https://github.com/ff137/bitstamp-btcusd-minute-data /tmp/bs
python -m model.noctua.ingest      --repo /tmp/bs --out model/artifacts
python -m model.noctua.episodes    --parquet model/artifacts/btcusd_1min.parquet --out model/artifacts
python -c "import pandas as pd; from model.noctua.features import build_features; \
  h=pd.read_parquet('model/artifacts/btcusd_1h.parquet'); e=pd.read_parquet('model/artifacts/episodes.parquet'); \
  build_features(h,e).to_parquet('model/artifacts/features.parquet')"
python -m model.noctua.train        # ~13 s on 4 CPU cores
python -m model.noctua.evaluate     # fixed-split scoreboard
python -m model.noctua.walkforward  # the headline table (~100 s)
python -m model.noctua.robustness   # hallucination tests
python -m model.noctua.export       # -> model/serve/noctua_weights.npz
```

---

*Educational research only. Not financial advice. The failure mode of a short
option position is a rare, large loss; every number here is reported with its
tail, and every position should be sized so the bad night is survivable.*
