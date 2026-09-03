---
title: NOCTUA BTC Overnight Barrier Model
emoji: 🦉
colorFrom: indigo
colorTo: gray
sdk: gradio
sdk_version: 4.44.0
app_file: app.py
pinned: false
license: mit
---

# NOCTUA — BTC overnight option-seller's barrier model

A **49,866-parameter** model that answers one question:

> For the 19-hour window from **17:00 UTC (22:30 IST)** to **12:00 UTC (17:30 IST)
> the next day** — the Delta Exchange BTC daily-option holding period — **which
> price levels are strong enough that they will not break?**

Runs on a free 2 vCPU / 16 GB Space: NumPy + SciPy only, no PyTorch, a 198 KB
weights file, ~6 ms per forecast.

## Endpoints

| Route | Purpose |
|---|---|
| `/` | status UI |
| `/api/noctua` | barrier survival curves + α-safe strikes |
| `/api/kronos` | legacy shape, drop-in for the retired Kronos demo scrape |
| `/api/health` | liveness + model metadata |

## What is and is not validated

Out-of-sample, expanding-window walk-forward, 2,046 non-overlapping production
episodes (2021–2026), against a well-specified **Log-HAR** benchmark:

- **Volatility — validated.** QLIKE 0.3113 vs 0.3203, a **2.79 % improvement,
  p = 0.043**, winning 5 of 6 yearly folds.
- **Deep-tail barriers — validated and the main result.** Mean calibration
  error at α = 1 %: **0.94 pp vs 3.33 pp** for the textbook Gaussian
  first-passage baseline; at α = 2 %, 1.38 pp vs 3.53 pp. The Gaussian
  *understates* deep-tail touch risk by 2–4×.
- **Body barriers (α = 10–20 %) — the Gaussian is better.** 2.0–2.7 pp vs our
  4.0–4.6 pp. Use NOCTUA where a seller actually operates (α ≤ 5 %).
- **Direction — NOT validated, and reported as such.** Log-loss 0.6941 against
  0.6931 for a coin flip: no skill. `upside` is emitted for dashboard
  compatibility with `upside_is_informative: false` attached.

Full method and results: [`RESEARCH_PLAN.md`](https://github.com/deeploopinnovations/btc-dashboard/blob/main/model/RESEARCH_PLAN.md)
and [`RESULTS.md`](https://github.com/deeploopinnovations/btc-dashboard/blob/main/model/RESULTS.md).

## Data

The feature set reaches back **365 days** (`reg_rv_vs_year`), so the long
history ships as a committed hourly bundle — `data/noctua_history.parquet`,
~716 KB, built by the same `build_hourly` used in training — and each run
fetches only the recent tail (one request). Short or gappy history is a hard
error: silently falling back to a feature's training mean would produce
confident, subtly wrong strike levels.

Trained on Bitstamp BTC/USD 1-minute bars, 2017-08 → 2026-08, via
[ff137/bitstamp-btcusd-minute-data](https://github.com/ff137/bitstamp-btcusd-minute-data).
Serving fetches 5-minute bars from the **same venue and pair** — venue
consistency matters because the target is a barrier touch, and different venues
wick to different extremes.

---

*Educational research only. Not financial advice. Short-option strategies fail
rarely and largely; size every position so the bad night is survivable.*
