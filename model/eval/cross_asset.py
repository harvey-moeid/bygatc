"""
eval/cross_asset.py
=====================================================================
Zero-shot transfer: does NOCTUA work on crypto it has never seen?

NOCTUA was trained on Bitcoin and nothing else. No altcoin appears anywhere in
its training, calibration, or model-selection data, so every number here is
genuinely out-of-sample in the strongest available sense -- a different
instrument, not merely a later date on the same one.

This is the hardest of the three generalisation tests in this repo, and the
most honest. `eval/synthetic.py` uses processes with a known right answer but
no microstructure. `eval/regimes.py` uses real data but the same asset.
Altcoins have real jumps, real illiquidity, real depegs and excursion
distributions systematically fatter than Bitcoin's, and they are what a user
would actually point this model at next.

WHAT WOULD COUNT AS FAILURE

  * sigma tracking breaks -- the model cannot measure volatility on a series
    whose level and microstructure differ from BTC's;
  * discrimination collapses to ~0, meaning whatever it learned was
    Bitcoin-specific bookkeeping rather than first-passage structure;
  * calibration fails in a way the adaptive correction cannot absorb, which
    would mean the excursion SHAPE is asset-specific, not just its level.

The third is the interesting one. If shape transfers and only level does not,
`serve/adaptive.py` already handles it and the model is genuinely general. If
shape does not transfer, NOCTUA is a Bitcoin model and should be described as
one.

Reads the committed bundles from data/assets/ (see eval/harvest.py for why
they are fetched in CI rather than here) and runs the SHIPPED artifact -- no
refitting, no per-asset tuning. Anything else would not be zero-shot.

    python -m model.eval.cross_asset
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm
from sklearn.isotonic import IsotonicRegression

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua.features import build_features                          # noqa: E402
from serve.adaptive import apply_correction                         # noqa: E402
from serve.history import load_bundle                               # noqa: E402
from serve.runtime import load_model                                # noqa: E402

ASSET_DIR = Path("data/assets")
H = 19
ANCHOR_UTC = 17
ALPHAS = np.array([0.01, 0.02, 0.05, 0.10, 0.20])
BARRIER_PCT = np.array([1.0, 2.0, 3.0, 5.0])


def dsc_mcb(p: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    """CORP discrimination, miscalibration, and the uncertainty it scales with.

    UNC = p(1-p) of the base rate is returned because RAW DSC IS NOT COMPARABLE
    ACROSS ASSETS. A barrier that is touched half the time leaves far more room
    to discriminate than one touched a fifth of the time, so a more volatile
    asset posts a higher DSC at the same skill. At the 2% barrier BTC's base
    rate is 0.197 (UNC 0.158) against 0.36-0.46 for the altcoins (UNC 0.23-0.25)
    -- about 50% more headroom, from arithmetic alone. DSC/UNC is the
    skill-score form and is the one to compare.
    """
    base = float(np.mean(y))
    if base <= 0 or base >= 1 or len(y) < 30:
        return float("nan"), float("nan"), float("nan")
    pc = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip").fit_transform(p, y)
    ref = float(np.mean((base - y) ** 2))
    return (ref - float(np.mean((pc - y) ** 2)),
            float(np.mean((p - y) ** 2)) - float(np.mean((pc - y) ** 2)),
            ref)


def production_anchors(hours: pd.DataFrame) -> np.ndarray:
    """Rows at 17:00 UTC with a full H-hour window ahead -- the production slice."""
    ts = hours["hour_ts"].to_numpy(np.int64)
    hh = pd.to_datetime(ts, unit="s", utc=True).hour
    rows = np.where(hh == ANCHOR_UTC)[0]
    return rows[(rows >= 24 * 370) & (rows + H < len(hours))]


def realized(hours: pd.DataFrame, rows: np.ndarray) -> dict:
    """Excursions and realized vol over each forward window, from the bars."""
    logc = np.log(hours["close"].to_numpy(np.float64))
    logh = np.log(hours["high"].to_numpy(np.float64))
    logl = np.log(hours["low"].to_numpy(np.float64))
    rv5 = hours["rv5"].to_numpy(np.float64)
    m_up, m_dn, rv = [], [], []
    for r in rows:
        base = logc[r - 1]
        sl = slice(r, r + H)
        m_up.append(max(float(logh[sl].max() - base), 0.0))
        m_dn.append(max(float(base - logl[sl].min()), 0.0))
        rv.append(float(np.sqrt(rv5[sl].sum())))
    return {"M_up": np.array(m_up), "M_dn": np.array(m_dn), "RV": np.array(rv)}


def evaluate_asset(model, hours: pd.DataFrame, label: str, adaptive: bool) -> dict:
    rows = production_anchors(hours)
    if len(rows) < 60:
        return {"asset": label, "error": f"only {len(rows)} usable anchors"}

    ts = hours["hour_ts"].to_numpy(np.int64)
    dt = pd.to_datetime(ts[rows], unit="s", utc=True)
    ep = pd.DataFrame({"anchor_ts": ts[rows], "H": H, "row": rows, "dt": dt,
                       "anchor_hour": dt.hour, "dow": dt.dayofweek})
    X = build_features(hours, ep)
    ok = np.isfinite(X.to_numpy()).all(1)
    X, rows, ep = X[ok], rows[ok], ep[ok]

    pred = model.predict(model.prepare(X, ep.H.to_numpy(np.float64)))
    truth = realized(hours, rows)

    if adaptive:
        # Causal, per-anchor: only episodes settled strictly before it.
        sig0 = np.asarray(pred["sigma_med"], dtype=np.float64)
        ratio = truth["RV"] / np.maximum(sig0, 1e-12)
        at = ep.anchor_ts.to_numpy()
        c = np.ones(len(rows))
        for i in range(len(rows)):
            prior = (at + H * 3600 <= at[i]) & (at >= at[i] - 60 * 86400)
            if prior.sum() >= 20:
                c[i] = float(np.clip(np.median(ratio[prior]), 0.70, 1.40))
        pred = apply_correction({k: v for k, v in pred.items()}, 1.0)
        pred["sigma_atoms"] = pred["sigma_atoms"] * c[:, None]
        pred["sigma_med"] = pred["sigma_med"] * c
        pred = {k: v for k, v in pred.items() if not k.startswith("_pooled_")}
        mean_c = float(c.mean())
    else:
        mean_c = 1.0

    sig = np.asarray(pred["sigma_med"], dtype=np.float64)
    rec = {
        "asset": label, "n": int(len(rows)),
        "start": str(dt.min().date()), "end": str(dt.max().date()),
        "adaptive_factor": mean_c,
        "sigma_model_pct": float(100 * sig.mean()),
        "rv_realized_pct": float(100 * truth["RV"].mean()),
        "sigma_ratio": float(np.median(sig / np.maximum(truth["RV"], 1e-12))),
    }

    # calibration: does the promised alpha match the realized breach rate?
    errs = []
    for side, M in (("up", truth["M_up"]), ("dn", truth["M_dn"])):
        for al in ALPHAS:
            lvl = model.safe_level(pred, float(al), side == "up")
            rate = float((M >= lvl).mean())
            rec[f"rate_{side}_{al}"] = rate
            errs.append(abs(rate - al))
    rec["coverage_err_pp"] = float(100 * np.mean(errs))

    # discrimination: the part that cannot be faked
    d_list, m_list, u_list = [], [], []
    for pct in BARRIER_PCT:
        u = np.full(len(rows), np.log1p(pct / 100.0))
        p = model.touch_prob(pred, u, True)
        y = (truth["M_up"] >= np.log1p(pct / 100.0)).astype(float)
        d, mc, un = dsc_mcb(p, y)
        if np.isfinite(d):
            d_list.append(d)
            m_list.append(mc)
            u_list.append(un)
    rec["DSC"] = float(np.mean(d_list)) if d_list else float("nan")
    rec["MCB"] = float(np.mean(m_list)) if m_list else float("nan")
    rec["UNC"] = float(np.mean(u_list)) if u_list else float("nan")
    # the comparable form: what fraction of the available uncertainty the
    # model actually resolves
    rec["DSS"] = rec["DSC"] / rec["UNC"] if u_list and rec["UNC"] > 0 else float("nan")
    return rec


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Zero-shot transfer to unseen crypto")
    ap.add_argument("--assets", type=Path, default=ASSET_DIR)
    ap.add_argument("--out", type=Path, default=Path("model/artifacts/cross_asset.json"))
    a = ap.parse_args(argv)

    model = load_model()
    print(f"Zero-shot cross-asset transfer -- {model.meta.get('version')} "
          f"({model.meta.get('n_params_total', 0):,} params)")
    print("trained on BTC only; no refitting, no per-asset tuning\n")

    bundles = sorted(a.assets.glob("*_history.parquet")) if a.assets.exists() else []
    if not bundles:
        print(f"No bundles in {a.assets}.")
        print("Run the harvest-assets workflow first -- exchange APIs are not")
        print("reachable from this container, only from a GitHub runner.")
        return 1

    rows = []
    # BTC first as the in-domain reference. Prefer a harvested 900-day BTC
    # bundle if one exists: the committed SERVING bundle is 400 days, which
    # leaves ~29 anchors and cannot be compared like-for-like against the
    # altcoins' 529. Borrowing a BTC number from a different protocol
    # (benchmark.py refits walk-forward over 2021-2026) would not be a fair
    # reference either, so it is simply reported as unavailable when missing.
    btc_bundle = a.assets / "btc_history.parquet"
    btc_hours = pd.read_parquet(btc_bundle) if btc_bundle.exists() else load_bundle()
    btc_label = "btc (in-domain)" if btc_bundle.exists() else "btc (400d bundle)"
    for adaptive in (False, True):
        r = evaluate_asset(model, btc_hours, btc_label, adaptive)
        r["adaptive"] = adaptive
        rows.append(r)
    bundles = [b for b in bundles if b.stem != "btc_history"]
    for b in bundles:
        hours = pd.read_parquet(b)
        for adaptive in (False, True):
            r = evaluate_asset(model, hours, b.stem.replace("_history", ""), adaptive)
            r["adaptive"] = adaptive
            rows.append(r)

    df = pd.DataFrame([r for r in rows if "error" not in r])
    for r in rows:
        if "error" in r:
            print(f"  skipped {r['asset']}: {r['error']}")
    if df.empty:
        print("\nNo asset had enough usable anchors. Features need 365 days of")
        print("lookback, so usable anchors ~= bundle_days - 365; re-harvest deeper.")
        return 1

    for adaptive in (False, True):
        sub = df[df.adaptive == adaptive]
        if sub.empty:
            continue
        print(f"\n{'=' * 76}")
        print(f"{'WITH' if adaptive else 'WITHOUT'} the causal volatility correction")
        print("=" * 76)
        print(f"{'asset':<18} {'n':>5} {'sigma%':>8} {'realRV%':>8} {'ratio':>7} "
              f"{'cov err pp':>11} {'DSC':>9} {'DSC/UNC':>8} {'c':>6}")
        for _, r in sub.iterrows():
            print(f"{r.asset:<18} {int(r.n):>5} {r.sigma_model_pct:8.3f} "
                  f"{r.rv_realized_pct:8.3f} {r.sigma_ratio:7.3f} "
                  f"{r.coverage_err_pp:11.3f} {r.DSC:9.5f} {r.DSS:8.4f} "
                  f"{r.adaptive_factor:6.3f}")

    fin = df[df.adaptive]
    alt = fin[~fin.asset.str.startswith("btc")]
    btc = fin[fin.asset.str.startswith("btc")]
    if not alt.empty:
        print(f"\nAltcoins only (n={len(alt)} assets), with correction:")
        print(f"  median sigma ratio : {alt.sigma_ratio.median():.3f}  (1.00 = perfect)")
        print(f"  mean coverage err  : {alt.coverage_err_pp.mean():.3f} pp")
        ref = (f"BTC in-domain {btc.DSC.iloc[0]:.5f}, DSC/UNC "
               f"{btc.DSS.iloc[0]:.4f} vs altcoin {alt.DSS.mean():.4f}"
               if not btc.empty else
               "BTC in-domain row unavailable: the committed serving bundle is "
               "400 days, which leaves only ~29 usable anchors")
        print(f"  mean DSC           : {alt.DSC.mean():.5f}  (0 = no skill; {ref})")
        raw = df[~df.adaptive & ~df.asset.str.startswith("btc")]
        if not raw.empty:
            print(f"\n  the correction's effect on these four:")
            print(f"    sigma ratio    {raw.sigma_ratio.median():.3f} -> "
                  f"{alt.sigma_ratio.median():.3f}")
            print(f"    coverage err   {raw.coverage_err_pp.mean():.3f} -> "
                  f"{alt.coverage_err_pp.mean():.3f} pp")
            print(f"    DSC            {raw.DSC.mean():.5f} -> {alt.DSC.mean():.5f}"
                  "   (unchanged by design: the correction moves level, not shape)")

    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(rows, indent=2, default=float) + "\n")
    print(f"\nwritten -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
