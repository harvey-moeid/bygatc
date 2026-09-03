"""
eval/synthetic.py
=====================================================================
Ground-truth test: feed NOCTUA instruments it has never seen, whose CORRECT
answer is known exactly, and measure the gap.

Every evaluation elsewhere in this project compares the model against other
models, or against one realized path per episode. Both are weak: the first is
only as good as the competitor, and the second gives a single Bernoulli draw
where a probability was forecast. Here the true barrier law is known in closed
form or to Monte-Carlo precision, so the model can be marked against the RIGHT
ANSWER rather than against a rival or a coin flip.

This is also the hallucination test. NOCTUA was trained exclusively on
Bitcoin. If it has memorised Bitcoin's typical excursion shape rather than
learning first-passage behaviour, it will impose that shape on any series it
is shown and be confidently wrong here.

THE INSTRUMENTS

  gbm_*      Driftless geometric Brownian motion at a known volatility. The
             reflection principle gives the exact first-passage law for the
             running maximum of a driftless Brownian path:

                 P(max_{t<=T} W_t >= u)  =  2 * Phi(-u / sigma_T)

             This is not an approximation and not a simulation -- it is the
             answer. Three volatility levels are used, one far below and one
             far above anything in Bitcoin's history, so the test also probes
             extrapolation.

  garch      GARCH(1,1) with persistent, clustering volatility. No closed
             form, so truth comes from 20,000 Monte-Carlo continuations of the
             true process from the true latent state.

  jump       Merton jump-diffusion: continuous diffusion plus rare large
             jumps. Fat tails that no Gaussian model can match. Truth by Monte
             Carlo. This is where a model that has quietly learned "crypto
             tails look like X" should break.

WHAT COUNTS AS PASSING

  For GBM the model should approach the analytic law. It will not match it
  exactly and should not be expected to: NOCTUA is trained on Bitcoin, whose
  excursions are fatter than Gaussian, so a mild conservative bias on GBM is
  correct behaviour, not error. What would be damning is the opposite -- the
  model UNDERSTATING touch probability on a process it has never seen, or
  failing to track sigma as sigma changes.

  The headline number is therefore the RATIO of forecast to true touch
  probability, and the direction of any miss matters more than its size.

    python -m model.eval.synthetic
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua.features import build_features                          # noqa: E402
from serve.runtime import load_model                                # noqa: E402

H_WINDOW = 19
BARS_PER_HOUR = 12                     # 5-minute bars, matching the real pipeline
HOURS = 24 * 400                       # 400 days, what the feature set needs
BARRIERS = np.array([0.005, 0.01, 0.02, 0.03, 0.05])


# ==========================================================================
# processes
# ==========================================================================
def gbm(n_bars: int, sigma_bar: float, rng) -> np.ndarray:
    return rng.normal(0.0, sigma_bar, n_bars)


def garch(n_bars: int, omega: float, alpha: float, beta: float, rng) -> np.ndarray:
    r = np.empty(n_bars)
    v = omega / max(1e-12, 1 - alpha - beta)
    for t in range(n_bars):
        z = rng.normal()
        r[t] = np.sqrt(v) * z
        v = omega + alpha * r[t] ** 2 + beta * v
    return r


def jump_diffusion(n_bars: int, sigma_bar: float, lam: float, jump_sd: float,
                   rng) -> np.ndarray:
    r = rng.normal(0.0, sigma_bar, n_bars)
    hits = rng.uniform(size=n_bars) < lam
    r[hits] += rng.normal(0.0, jump_sd, int(hits.sum()))
    return r


# ==========================================================================
# pipeline: log-returns -> the hourly frame the feature builder expects
# ==========================================================================
def to_hourly(log_ret: np.ndarray, start_price: float = 30000.0,
              t0: int = 1_600_000_000) -> pd.DataFrame:
    n_hours = len(log_ret) // BARS_PER_HOUR
    r = log_ret[: n_hours * BARS_PER_HOUR].reshape(n_hours, BARS_PER_HOUR)
    logp = np.log(start_price) + np.cumsum(log_ret[: n_hours * BARS_PER_HOUR])
    price = np.exp(logp).reshape(n_hours, BARS_PER_HOUR)

    prev_close = np.concatenate([[start_price], price[:-1, -1]])
    rows = {
        "hour_ts": t0 + 3600 * np.arange(n_hours),
        "open": prev_close,
        "high": price.max(axis=1),
        "low": price.min(axis=1),
        "close": price[:, -1],
        "volume": np.full(n_hours, 100.0),
        "rv5": (r ** 2).sum(axis=1),
        "rv5_pos": (np.maximum(r, 0) ** 2).sum(axis=1),
        "rv5_neg": (np.minimum(r, 0) ** 2).sum(axis=1),
        "bpv5": (np.abs(r[:, :-1]) * np.abs(r[:, 1:])).sum(axis=1) * (np.pi / 2),
        "rq5": BARS_PER_HOUR / 3.0 * (r ** 4).sum(axis=1),
    }
    df = pd.DataFrame(rows)
    df["high"] = np.maximum(df.high, np.maximum(df.open, df.close))
    df["low"] = np.minimum(df.low, np.minimum(df.open, df.close))
    return df


def truth_mc(gen, state_args, n_paths: int, rng) -> dict:
    """Monte-Carlo the true touch probability from the true process."""
    n = H_WINDOW * BARS_PER_HOUR
    up = np.zeros(len(BARRIERS))
    dn = np.zeros(len(BARRIERS))
    for _ in range(n_paths):
        r = gen(n, *state_args, rng)
        c = np.cumsum(r)
        up += (c.max() >= BARRIERS).astype(float)
        dn += ((-c.min()) >= BARRIERS).astype(float)
    return {"up": up / n_paths, "dn": dn / n_paths}


def truth_gbm_analytic(sigma_window: float) -> np.ndarray:
    """Exact reflection-principle first-passage law. No simulation."""
    return 2.0 * norm.cdf(-BARRIERS / sigma_window)


def evaluate(model, hours: pd.DataFrame, label: str, truth_up: np.ndarray,
             truth_dn: np.ndarray, sigma_true: float) -> dict:
    """Run the real serving path on a synthetic instrument."""
    n_rows = len(hours)
    rows = np.arange(n_rows - 200, n_rows - 1)     # last ~200 anchors
    dt = pd.to_datetime(hours.hour_ts.to_numpy()[rows], unit="s", utc=True)
    ep = pd.DataFrame({"anchor_ts": hours.hour_ts.to_numpy()[rows], "H": H_WINDOW,
                       "row": rows, "dt": dt, "anchor_hour": dt.hour,
                       "dow": dt.dayofweek})
    X = build_features(hours, ep)
    d = model.prepare(X, ep.H.to_numpy(np.float64))
    pred = model.predict(d)

    p_up = np.array([model.touch_prob(pred, np.full(len(rows), u), True).mean()
                     for u in BARRIERS])
    p_dn = np.array([model.touch_prob(pred, np.full(len(rows), u), False).mean()
                     for u in BARRIERS])
    sig_hat = float(np.mean(pred["sigma_med"]))

    return {
        "instrument": label,
        "sigma_true_pct": 100 * sigma_true,
        "sigma_model_pct": 100 * sig_hat,
        "sigma_ratio": sig_hat / max(sigma_true, 1e-12),
        "p_up": p_up.tolist(), "p_dn": p_dn.tolist(),
        "truth_up": truth_up.tolist(), "truth_dn": truth_dn.tolist(),
        "ratio_up": (p_up / np.maximum(truth_up, 1e-9)).tolist(),
        "ratio_dn": (p_dn / np.maximum(truth_dn, 1e-9)).tolist(),
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Synthetic ground-truth tests")
    p.add_argument("--paths", type=int, default=20000)
    p.add_argument("--out", type=Path, default=Path("model/artifacts/synthetic.json"))
    a = p.parse_args(argv)

    model = load_model()
    print(f"Synthetic ground-truth battery -- {model.meta.get('version')}\n")
    print(f"barriers: {(100*BARRIERS).round(1).tolist()} %   window: {H_WINDOW}h\n")
    rng = np.random.default_rng(7)
    n_bars = HOURS * BARS_PER_HOUR
    results = []

    # ---- GBM at three volatility levels, analytic truth --------------------
    # 19h window sigma of 1%, 3% and 9% -- BTC's own is ~2-4%, so the outer
    # two are genuine extrapolation.
    for target_pct in (1.0, 3.0, 9.0):
        sw = target_pct / 100.0
        sigma_bar = sw / np.sqrt(H_WINDOW * BARS_PER_HOUR)
        hours = to_hourly(gbm(n_bars, sigma_bar, rng))
        truth = truth_gbm_analytic(sw)
        r = evaluate(model, hours, f"gbm_{target_pct:g}pct", truth, truth, sw)
        r["truth_source"] = "analytic (reflection principle)"
        results.append(r)

    # ---- GARCH(1,1), Monte-Carlo truth from the true state -----------------
    sigma_bar = 0.03 / np.sqrt(H_WINDOW * BARS_PER_HOUR)
    omega, alpha_g, beta_g = sigma_bar ** 2 * 0.05, 0.05, 0.90
    hours = to_hourly(garch(n_bars, omega, alpha_g, beta_g, rng))
    t = truth_mc(garch, (omega, alpha_g, beta_g), a.paths // 10, rng)
    sw = float(np.sqrt(omega / (1 - alpha_g - beta_g) * H_WINDOW * BARS_PER_HOUR))
    r = evaluate(model, hours, "garch11", t["up"], t["dn"], sw)
    r["truth_source"] = f"monte carlo ({a.paths // 10} paths)"
    results.append(r)

    # ---- Merton jump diffusion, Monte-Carlo truth --------------------------
    sigma_bar = 0.02 / np.sqrt(H_WINDOW * BARS_PER_HOUR)
    lam, jsd = 0.0015, 0.02
    hours = to_hourly(jump_diffusion(n_bars, sigma_bar, lam, jsd, rng))
    t = truth_mc(jump_diffusion, (sigma_bar, lam, jsd), a.paths // 10, rng)
    sw = float(np.sqrt(H_WINDOW * BARS_PER_HOUR * (sigma_bar ** 2 + lam * jsd ** 2)))
    r = evaluate(model, hours, "jump_diffusion", t["up"], t["dn"], sw)
    r["truth_source"] = f"monte carlo ({a.paths // 10} paths)"
    results.append(r)

    # ---- report ------------------------------------------------------------
    print(f"{'instrument':<16} {'sigma true':>11} {'sigma model':>12} {'ratio':>7}   truth")
    for r in results:
        print(f"{r['instrument']:<16} {r['sigma_true_pct']:10.3f}% "
              f"{r['sigma_model_pct']:11.3f}% {r['sigma_ratio']:7.3f}   {r['truth_source']}")

    print("\nTOUCH PROBABILITY vs TRUTH  (upside; ratio = model / true)")
    print(f"{'instrument':<16} " + " ".join(f"{100*b:>6.1f}%" for b in BARRIERS))
    for r in results:
        print(f"{r['instrument']:<16} " +
              " ".join(f"{x:6.2f}" for x in r["ratio_up"]))

    print("\nRaw numbers, 2% barrier:")
    print(f"{'instrument':<16} {'model':>8} {'true':>8}")
    k = int(np.argmin(np.abs(BARRIERS - 0.02)))
    for r in results:
        print(f"{r['instrument']:<16} {r['p_up'][k]:8.4f} {r['truth_up'][k]:8.4f}")

    # a model that has memorised BTC would ignore sigma; one that models
    # first passage tracks it across two orders of magnitude
    ratios = [r["sigma_ratio"] for r in results if r["instrument"].startswith("gbm")]
    print(f"\nsigma tracking across a 9x volatility range: "
          f"ratios {np.round(ratios, 3).tolist()}  "
          f"(spread {max(ratios)/min(ratios):.2f}x -- 1.00 would be perfect)")

    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(results, indent=2, default=float) + "\n")
    print(f"\nwritten -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
