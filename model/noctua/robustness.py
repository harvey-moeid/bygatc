"""
noctua/robustness.py
=====================================================================
Stage 7: does the model hallucinate?

The question the user asked -- "check if it hallucinates" -- has a precise
statistical form for a probabilistic forecaster:

    When the input carries no signal, does the model fall back to the
    unconditional distribution and widen appropriately, or does it keep
    emitting confident, varying, wrong forecasts?

A model that has memorised structure rather than learned it will keep producing
sharply varying predictions on data where no such structure exists. So we feed
it series where we KNOW the answer:

  shuffle   1-minute log returns randomly permuted. Destroys volatility
            clustering entirely while preserving the unconditional return
            distribution exactly. The HAR cascade should become uninformative,
            so a healthy model's forecast dispersion must COLLAPSE and its
            R^2 must go to ~0. Barrier calibration should survive, because the
            standardized-shape head is scale-invariant and shuffling does not
            change the shape of a path's excursions much.

  iid       returns replaced by IID Gaussian noise with matched variance.
            Same expectation, plus the fat tails are gone.

  flat      a literally constant price. Realized vol is zero. The model must
            not produce a confident non-trivial barrier.

  early     BTC 2013-2016 -- real data, but genuinely out-of-distribution
            microstructure (24-39% zero-volume minutes, pre-institutional
            liquidity). This is the honest cross-regime generalisation test
            available to us: the egress policy blocks every venue API, and the
            one GitHub-mirrored ETH dataset publishes to Kaggle rather than to
            the repo, so a true cross-ASSET test could not be run here.

Intrabar ranges are carried along with their returns through the shuffle, so
surrogate bars keep a realistic high/low structure instead of degenerating to
zero-range candles (which would trivially and misleadingly suppress barrier
touches).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from . import baselines as B
from . import infer as I
from . import splits as S
from .episodes import build_episodes, build_hourly
from .features import build_features
from .model import BASE_COLS
from .train import load_all, prepare
from .evaluate import load_model, stds_from_ck


def make_surrogate(df: pd.DataFrame, kind: str, seed: int = 0) -> pd.DataFrame:
    """Build a synthetic 1-minute frame with a known absence of structure."""
    rng = np.random.default_rng(seed)
    out = df.copy()
    close = df["close"].to_numpy(np.float64)
    logc = np.log(close)
    ret = np.diff(logc, prepend=logc[0])

    # relative intrabar wicks, carried with their bar
    up = np.log(df["high"].to_numpy(np.float64)) - logc
    dn = logc - np.log(df["low"].to_numpy(np.float64))

    if kind == "shuffle":
        idx = rng.permutation(len(ret))
        ret, up, dn = ret[idx], up[idx], dn[idx]
    elif kind == "iid":
        ret = rng.normal(0.0, ret.std(), size=len(ret))
        idx = rng.permutation(len(up))
        up, dn = up[idx], dn[idx]
    elif kind == "flat":
        ret = np.zeros_like(ret)
        up = np.zeros_like(up)
        dn = np.zeros_like(dn)
    else:
        raise ValueError(kind)

    new_log = logc[0] + np.cumsum(ret)
    new_close = np.exp(new_log)
    out["close"] = new_close
    out["open"] = np.concatenate([[new_close[0]], new_close[:-1]])
    out["high"] = new_close * np.exp(np.abs(up))
    out["low"] = new_close * np.exp(-np.abs(dn))
    out["bad_print"] = False
    return out


def score(ep, X, model, ck, mask, label, har_from):
    """Predictive-dispersion and calibration diagnostics on one dataset."""
    fin = np.isfinite(X.to_numpy()).all(1)
    m = mask & fin
    n = int(m.sum())
    if n < 100:
        return {"case": label, "n": n, "note": "insufficient episodes"}

    d, _ = prepare(ep, X, m, *stds_from_ck(ck))
    pred = I.predict(model, d, har_logvol=har_from(X[m]))
    e = ep[m]

    H = e.H.to_numpy(np.float64)
    y = B.har_target(e.RV.to_numpy(), H)
    yhat = np.log(pred["sigma_med"]) - 0.5 * np.log(H)

    M_up, M_dn = e.M_up.to_numpy(), -e.M_dn.to_numpy()
    cov = {}
    for a in (0.05, 0.20):
        u = I.safe_level(pred, a, up=True)
        l = I.safe_level(pred, a, up=False)
        cov[f"touch@{a:.2f}_up"] = float((M_up >= u).mean())
        cov[f"touch@{a:.2f}_dn"] = float((M_dn >= l).mean())

    return {
        "case": label,
        "n": n,
        "forecast_sd": float(np.std(yhat)),        # dispersion of the forecast
        "actual_sd": float(np.std(y)),
        "R2_log": float(B.r2_log(yhat, y)),
        "median_pred_RV_pct": float(100 * np.median(pred["sigma_med"])),
        "median_true_RV_pct": float(100 * np.median(e.RV.to_numpy())),
        **cov,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Robustness / hallucination tests")
    p.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    p.add_argument("--model", type=Path, default=Path("model/artifacts/noctua.pt"))
    p.add_argument("--out", type=Path, default=Path("model/artifacts/robustness.json"))
    a = p.parse_args(argv)

    model, ck = load_model(a.model)
    ep0, X0 = load_all(a.artifacts)
    fin0 = np.isfinite(X0.to_numpy()).all(1)
    sp = S.time_splits(ep0)
    prod = S.production_mask(ep0)

    # Log-HAR reference, fitted once on the real training split
    y0 = B.har_target(ep0.RV.to_numpy(), ep0.H.to_numpy())
    m_tr = sp["train"] & fin0
    har = B.fit_vol_baselines(X0[m_tr], y0[m_tr], S.sample_weights(ep0, m_tr))["log_har_cal"]
    har_fn = har.predict

    rows = [score(ep0, X0, model, ck, sp["test"] & prod, "REAL BTC (test split)", har_fn)]

    # out-of-distribution real data: the pre-institutional era
    early = (ep0.dt < pd.Timestamp("2017-01-01", tz="UTC")).to_numpy()
    rows.append(score(ep0, X0, model, ck, early & prod, "REAL BTC 2012-2016 (OOD era)", har_fn))

    df = pd.read_parquet(a.artifacts / "btcusd_1min.parquet")
    for kind in ("shuffle", "iid", "flat"):
        print(f"[robust] building surrogate: {kind} ...")
        sdf = make_surrogate(df, kind)
        h = build_hourly(sdf)
        e = build_episodes(h, (19,))
        Xs = build_features(h, e)
        if len(e) == 0:
            rows.append({"case": f"SURROGATE {kind}", "n": 0,
                         "note": "pipeline produced zero episodes (RV==0) -- "
                                 "correctly refuses to forecast a degenerate series"})
            continue
        finm = np.isfinite(Xs.to_numpy()).all(1)
        m = (e.anchor_hour == 17).to_numpy() & (e.dt >= pd.Timestamp("2017-08-01", tz="UTC")).to_numpy()
        rows.append(score(e, Xs, model, ck, m & finm, f"SURROGATE {kind}", har_fn))

    tab = pd.DataFrame(rows)
    print()
    print(tab.round(4).to_string(index=False))
    a.out.write_text(json.dumps(rows, indent=2, default=float) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
