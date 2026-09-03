# NOCTUA

A **49,866-parameter** model for one decision: the BTC option seller's
**19-hour overnight window**, 17:00 UTC (22:30 IST) → 12:00 UTC (17:30 IST),
which is the Delta Exchange daily-option holding period.

It answers *"which levels are strong enough that they will not break?"* as a
calibrated **barrier survival curve**, not a point forecast.

| | |
|---|---|
| [`RESEARCH_PLAN.md`](RESEARCH_PLAN.md) | problem formalization, literature, architecture, protocol |
| [`RESULTS.md`](RESULTS.md) | out-of-sample results **including the negative ones** |
| `noctua/` | pipeline: ingest → episodes → features → train → evaluate → export |
| `serve/` | NumPy-only runtime + Hugging Face Space app |
| `eval/kronos_baseline.py` | head-to-head vs Kronos — **written, not yet run** (see below) |

## Headline

Out-of-sample walk-forward, 2,046 non-overlapping production episodes:

- **Volatility:** beats a well-specified Log-HAR by **2.79 % QLIKE**, p = 0.043,
  5/6 folds.
- **Deep-tail barriers:** calibration error **0.94 pp vs 3.33 pp** for the
  Gaussian first-passage baseline at α = 1 %. The textbook model understates
  deep-tail touch risk by 2–4×.
- **Body barriers (α ≥ 10 %):** the Gaussian is better. Reported, not hidden.
- **Direction:** no skill (log-loss 0.6941 vs 0.6931 for a coin flip). The
  served `upside` field is pinned to 50.
- **Kronos:** not benchmarked — `huggingface.co` is blocked in the build
  environment, so no superiority claim over Kronos is made here.

## Why it replaced the Kronos scrape

`data/kronos.json` had been serving a fossil: the public demo's last genuine
timestamp was `2026-07-04 11:00:26 UTC`, ~880 hours stale, and
`scripts/parse-kronos.js` re-committed it every 30 minutes. That script is now
retired; `model/serve/predict.py` produces `data/kronos.json` (legacy shape,
drop-in) and `data/noctua.json` (barrier curves + safe strikes).

## Quick start

```bash
pip install -r serve/requirements-ci.txt
python serve/predict.py --out-dir data      # live forecast
```

Full reproduction from raw data is in [`RESULTS.md` §8](RESULTS.md#8-reproducing).

---

*Educational research only. Not financial advice.*
