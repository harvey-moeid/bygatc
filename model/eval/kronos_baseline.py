"""
eval/kronos_baseline.py
=====================================================================
Head-to-head: NOCTUA vs Kronos, on identical windows and identical scoring.

THIS SCRIPT HAS NOT BEEN RUN. It cannot be run in the environment this project
was built in: the session's egress policy blocks `huggingface.co`, so the
Kronos weights cannot be downloaded (see RESEARCH_PLAN section 8.2). It is
shipped complete so the comparison can be executed anywhere with normal network
access, and so the claim can be settled with evidence rather than argument.

Until it has been run, **this repository makes no empirical claim of
superiority over Kronos.** What it does claim, and has measured, is
superiority over a well-specified Log-HAR and over the Gaussian first-passage
baseline in the deep tail -- see RESULTS.md. The structural arguments against
using a generative candle model for this task (RESEARCH_PLAN section 2.2) stand
on their own, but they are arguments, not measurements.

Usage (in an environment with HF access):

    pip install torch pandas numpy huggingface_hub
    git clone https://github.com/shiyu-coder/Kronos && export KRONOS_REPO=$PWD/Kronos
    python model/eval/kronos_baseline.py --samples 64 --episodes 200

What is compared
----------------
For each production episode (17:00 UTC anchor, 19h window), Kronos is given the
same 512 hourly candles NOCTUA's features are derived from, asked for 19 hourly
steps, and rolled out `--samples` times. From those rollouts we compute the
same functionals NOCTUA outputs -- realized vol, P(up), and the barrier touch
probabilities -- and score them with the same proper scoring rules.

The comparison is deliberately generous to Kronos: it gets more Monte-Carlo
samples than the dashboard's own kronos_local/app.py used (24), and the wall
clock is reported so the compute asymmetry is explicit rather than asserted.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua import baselines as B          # noqa: E402
from noctua import infer as I              # noqa: E402
from noctua import splits as S             # noqa: E402
from noctua.evaluate import load_model, stds_from_ck   # noqa: E402
from noctua.train import load_all, prepare             # noqa: E402

ALPHAS = (0.01, 0.02, 0.05, 0.10, 0.20)
CONTEXT = 512
PRED_LEN = 19


def load_kronos(model_name: str, tokenizer_name: str, device: str = "cpu"):
    repo = os.environ.get("KRONOS_REPO")
    if repo and repo not in sys.path:
        sys.path.insert(0, repo)
    from model import Kronos, KronosPredictor, KronosTokenizer  # type: ignore

    tok = KronosTokenizer.from_pretrained(tokenizer_name)
    mdl = Kronos.from_pretrained(model_name)
    return KronosPredictor(mdl, tok, device=device, max_context=CONTEXT)


def kronos_functionals(pred, hours: pd.DataFrame, row: int, n_samples: int):
    """Roll Kronos out n_samples times and reduce to our target functionals."""
    ctx = hours.iloc[row - CONTEXT:row]
    x_df = ctx[["open", "high", "low", "close", "volume"]].copy()
    x_df["amount"] = ctx["close"] * ctx["volume"]
    x_ts = pd.Series(pd.to_datetime(ctx["hour_ts"], unit="s"))
    y_ts = pd.Series(pd.date_range(x_ts.iloc[-1] + pd.Timedelta(hours=1),
                                   periods=PRED_LEN, freq="h"))
    s_tau = float(ctx["close"].iloc[-1])

    R, RV, MU, MD = [], [], [], []
    for _ in range(n_samples):
        p = pred.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts,
                         pred_len=PRED_LEN, T=1.0, top_p=0.9,
                         sample_count=1, verbose=False)
        c = p["close"].to_numpy(float)
        hi = p["high"].to_numpy(float) if "high" in p else c
        lo = p["low"].to_numpy(float) if "low" in p else c
        R.append(np.log(c[-1] / s_tau))
        RV.append(float(np.sqrt(np.sum(np.diff(np.log(np.r_[s_tau, c])) ** 2))))
        MU.append(max(0.0, float(np.log(hi.max() / s_tau))))
        MD.append(max(0.0, float(-np.log(lo.min() / s_tau))))
    return map(np.asarray, (R, RV, MU, MD))


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Kronos vs NOCTUA head-to-head")
    p.add_argument("--artifacts", type=Path, default=Path("model/artifacts"))
    p.add_argument("--noctua", type=Path, default=Path("model/artifacts/noctua.pt"))
    p.add_argument("--kronos-model", default="NeoQuasar/Kronos-small")
    p.add_argument("--kronos-tokenizer", default="NeoQuasar/Kronos-Tokenizer-base")
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--episodes", type=int, default=200)
    p.add_argument("--out", type=Path, default=Path("model/artifacts/kronos_headtohead.json"))
    a = p.parse_args(argv)

    ep, X = load_all(a.artifacts)
    hours = pd.read_parquet(a.artifacts / "btcusd_1h.parquet")
    fin = np.isfinite(X.to_numpy()).all(1)
    sp = S.time_splits(ep)
    m_te = sp["test"] & fin & S.production_mask(ep)
    idx = np.flatnonzero(m_te)[-a.episodes:]

    # ---- NOCTUA ----------------------------------------------------------
    model, ck = load_model(a.noctua)
    m_tr = sp["train"] & fin
    y = B.har_target(ep.RV.to_numpy(), ep.H.to_numpy())
    har = B.fit_vol_baselines(X[m_tr], y[m_tr], S.sample_weights(ep, m_tr))["log_har_cal"]
    sel = np.zeros(len(ep), bool); sel[idx] = True
    d, _ = prepare(ep, X, sel, *stds_from_ck(ck))
    t0 = time.time()
    npred = I.predict(model, d, har_logvol=har.predict(X[sel]))
    noctua_sec = time.time() - t0

    e = ep[sel]
    M_up, M_dn, RV_true, R_true = (e.M_up.to_numpy(), -e.M_dn.to_numpy(),
                                   e.RV.to_numpy(), e.R.to_numpy())

    # ---- Kronos ----------------------------------------------------------
    kp = load_kronos(a.kronos_model, a.kronos_tokenizer)
    k_rv, k_pup, k_touch_u, k_touch_d = [], [], [], []
    t0 = time.time()
    for j, i in enumerate(idx):
        row = int(ep["row"].to_numpy()[i])
        Rk, RVk, MUk, MDk = kronos_functionals(kp, hours, row, a.samples)
        k_rv.append(np.median(RVk))
        k_pup.append(float((Rk > 0).mean()))
        k_touch_u.append(MUk); k_touch_d.append(MDk)
        if j % 10 == 0:
            print(f"  kronos {j}/{len(idx)}  ({time.time()-t0:.0f}s)", flush=True)
    kronos_sec = time.time() - t0

    k_rv = np.asarray(k_rv)
    res = {
        "n_episodes": len(idx), "kronos_samples": a.samples,
        "seconds": {"noctua": round(noctua_sec, 2), "kronos": round(kronos_sec, 1),
                    "speedup": round(kronos_sec / max(noctua_sec, 1e-9), 1)},
        "qlike": {
            "noctua": B.qlike(npred["sigma_med"] ** 2, RV_true**2),
            "kronos": B.qlike(k_rv**2, RV_true**2),
            "log_har": B.qlike((np.exp(har.predict(X[sel])) * np.sqrt(19)) ** 2, RV_true**2),
        },
        "direction_logloss": {
            "noctua": B.log_loss(I.prob_up(npred), (R_true > 0)),
            "kronos": B.log_loss(np.asarray(k_pup), (R_true > 0)),
            "coin_flip": B.log_loss(np.full(len(idx), 0.5), (R_true > 0)),
        },
        "barrier_calibration_err_pp": [],
    }
    for al in ALPHAS:
        un = I.safe_level(npred, al, True); ln = I.safe_level(npred, al, False)
        # Kronos: the level its own rollouts put at the alpha quantile
        uk = np.array([np.quantile(m, 1 - al) for m in k_touch_u])
        lk = np.array([np.quantile(m, 1 - al) for m in k_touch_d])
        res["barrier_calibration_err_pp"].append({
            "alpha": al,
            "noctua": 100 * 0.5 * (abs((M_up >= un).mean() - al) + abs((M_dn >= ln).mean() - al)),
            "kronos": 100 * 0.5 * (abs((M_up >= uk).mean() - al) + abs((M_dn >= lk).mean() - al)),
        })

    a.out.write_text(json.dumps(res, indent=2, default=float) + "\n")
    print(json.dumps(res, indent=2, default=float))
    return 0


if __name__ == "__main__":
    sys.exit(main())
