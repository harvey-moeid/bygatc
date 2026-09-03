"""
serve/predict.py
=====================================================================
One forecast, end to end: live bars -> features -> NOCTUA -> JSON.

Emits two payloads.

`legacy` is byte-compatible with what `src/data.js fetchKronos()` already
consumes, so the dead Kronos scrape can be replaced without touching the
dashboard. Two fields need an honest mapping:

  upside  PINNED TO 50.0. Walk-forward found NO directional skill at this
          horizon (log-loss 0.6941 vs 0.6931 for a coin flip -- fractionally
          WORSE than nothing), independently reproducing this repo's own
          SELLER_DIRECTIONAL_ALPHA.md conclusion that direction is a coin
          flip. Since src/data.js pipes this field into strike selection,
          passing the raw number through would trade on noise. The raw value
          is published untouched as `p_up_raw`. See `to_legacy` for the full
          argument.

  volAmp  P(RV over the window > trailing RV of the same length). This one IS
          a real forecast -- it comes from Stage A, which beats Log-HAR by
          2.79% QLIKE (p = 0.043, 5/6 walk-forward folds).

`noctua` is the real product: barrier survival curves and the alpha-safe
strike levels an option seller actually needs.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noctua.features import build_features                    # noqa: E402
from serve.adaptive import apply_correction, volatility_correction  # noqa: E402
from serve.fetch import fetch_bars                            # noqa: E402
from serve.history import get_hours, load_bundle              # noqa: E402
from serve.runtime import load_model                          # noqa: E402

_MODEL_TAG = ["NOCTUA-v1"]   # set by main() once the artifact is chosen

PROD_H = 19
PROD_ANCHOR_UTC = 17
ALPHAS = (0.01, 0.02, 0.05, 0.10, 0.20)
BARRIER_GRID_PCT = (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.5, 10.0)


def _next_anchor(now_ts: int) -> int:
    """The next 17:00 UTC boundary at or before `now` (today's if past)."""
    dt = datetime.fromtimestamp(now_ts, timezone.utc)
    anchor = dt.replace(hour=PROD_ANCHOR_UTC, minute=0, second=0, microsecond=0)
    return int(anchor.timestamp())


def forecast(model, hours: pd.DataFrame, H: int = PROD_H,
             anchor_ts: int | None = None, source: str = "unknown") -> dict:
    """Run one forecast anchored at `anchor_ts` (default: the latest full hour).

    `hours` is the merged hourly history from `serve.history.get_hours` --
    committed bundle plus the freshly fetched tail. It must reach back at least
    365 days, because `reg_rv_vs_year` looks that far and a short history would
    silently fall back to the feature's training mean rather than fail.
    """
    hour_ts = hours["hour_ts"].to_numpy(np.int64)

    if anchor_ts is None:
        anchor_ts = int(hour_ts[-1])          # forecast from the last closed hour
    row = int(np.searchsorted(hour_ts, anchor_ts))
    row = min(row, len(hours) - 1)
    if row < 24 * 22:
        raise RuntimeError("not enough history at the requested anchor")

    dt = pd.to_datetime(hour_ts[row], unit="s", utc=True)
    ep = pd.DataFrame({
        "anchor_ts": [hour_ts[row]], "H": [H], "row": [row],
        "dt": [dt], "anchor_hour": [dt.hour], "dow": [dt.dayofweek],
    })
    X = build_features(hours, ep)
    d = model.prepare(X, np.array([float(H)]))
    pred = model.predict(d)

    # Causal volatility-level recalibration. Measured out of sample on
    # 2024-07 onward, the raw forecast runs high -- realized vol lands below
    # it 66.4% of the time -- which pushes every quoted strike too far out and
    # costs premium. The correction is estimated only from episodes that have
    # already settled, so it carries no look-ahead. See serve/adaptive.py.
    cal = volatility_correction(model, hours, row, H)
    if cal["applied"]:
        pred = apply_correction(pred, cal["factor"])

    spot = float(hours["close"].to_numpy()[row - 1])
    sigma = float(pred["sigma_med"][0])

    # trailing realized vol over the same window length, for volAmp
    rv5 = hours["rv5"].to_numpy(np.float64)
    trailing = float(np.sqrt(rv5[row - H:row].sum()))
    rv_q = np.stack([np.interp([0.5], model.levels, r) for r in pred["qa"]])
    p_amp = float(model_prob_rv_above(model, pred, trailing))

    curves = {"up": [], "dn": []}
    for pct in BARRIER_GRID_PCT:
        u = np.array([np.log1p(pct / 100.0)])
        curves["up"].append({
            "pct": pct, "price": round(spot * (1 + pct / 100.0), 2),
            "touch_prob": round(float(model.touch_prob(pred, u, True)[0]), 4)})
        curves["dn"].append({
            "pct": -pct, "price": round(spot * (1 - pct / 100.0), 2),
            "touch_prob": round(float(model.touch_prob(pred, u, False)[0]), 4)})

    safe = []
    for a in ALPHAS:
        u = float(model.safe_level(pred, a, True)[0])
        l = float(model.safe_level(pred, a, False)[0])
        safe.append({
            "alpha": a,
            "call_strike": round(spot * float(np.exp(u)), 2),
            "put_strike": round(spot * float(np.exp(-l)), 2),
            "call_pct": round(100 * (np.exp(u) - 1), 3),
            "put_pct": round(-100 * (1 - np.exp(-l)), 3),
        })

    p_up = float(model.prob_up(pred)[0])
    settle = int(hour_ts[row] + H * 3600)
    return {
        "anchor_utc": str(dt), "settle_utc": str(pd.to_datetime(settle, unit="s", utc=True)),
        "H_hours": H, "spot": round(spot, 2),
        "sigma_window_pct": round(100 * sigma, 3),
        "sigma_annualized_pct": round(100 * sigma * np.sqrt(365 * 24 / H), 1),
        "trailing_rv_pct": round(100 * trailing, 3),
        "p_up": round(p_up, 4),
        "p_vol_amplify": round(p_amp, 4),
        "safe_levels": safe,
        "barrier_curves": curves,
        "model": model.meta.get("version", "NOCTUA-v1"),
        "vol_calibration": {
            "factor": round(float(cal["factor"]), 4),
            "applied": bool(cal["applied"]),
            "n_settled_episodes": int(cal["n_episodes"]),
            "window_days": int(cal["window_days"]),
            "note": cal["reason"],
        },
        "source": source,
        "history_hours": int(len(hours)),
    }


def model_prob_rv_above(model, pred: dict, threshold: float) -> float:
    """P(realized vol over the window exceeds `threshold`), from Stage A."""
    qa = pred["qa"][0]
    H = pred["H"][0]
    tot = np.exp(qa) * np.sqrt(H)             # window vol at each quantile level
    return float(1.0 - np.interp(threshold, tot, model.levels, left=0.0, right=1.0))


def to_legacy(f: dict) -> dict:
    """The exact JSON shape `src/data.js fetchKronos()` already handles.

    `upside` is deliberately pinned to 50.0 rather than passed through.

    This is not timidity, it is the only defensible option. `src/data.js` feeds
    `kronos.upside` into `UI.computeStrikes()` to SKEW the recommended call and
    put strikes, and into the conviction score. Publishing a directional number
    with no validated skill (walk-forward log-loss 0.6941 vs 0.6931 for a coin
    flip) would push real strike recommendations around on noise -- strictly
    worse than staying neutral. The dashboard already handles a neutral reading
    correctly: `Math.abs(upside - 50) < 5` raises "no directional edge for
    asymmetric wing", which is precisely the right conclusion.

    The model's raw P(R > 0) is still published as `p_up_raw` (and in
    noctua.json) so nothing is hidden -- it simply is not wired to anything
    that trades.
    """
    now_ms = int(time.time() * 1000)
    return {
        "upside": 50.0,
        "p_up_raw": round(100 * f["p_up"], 1),
        "volAmp": round(100 * f["p_vol_amplify"], 1),
        "sourceTs": f["anchor_utc"][:19],
        "sourceMs": int(pd.Timestamp(f["anchor_utc"]).timestamp() * 1000),
        "tz": "UTC",
        "ageHrs": 0.0,
        "freshness": "fresh",
        "fetchedAt": now_ms,
        "proxy": "noctua-local",
        "_updatedMs": now_ms,
        "model": f.get("model", _MODEL_TAG[0]),
        "upside_is_informative": False,
        "warning": (
            "upside is pinned to 50.0 on purpose: direction is NOT predictable at "
            "this horizon (walk-forward log-loss 0.6941 vs 0.6931 for a coin flip), "
            "and src/data.js uses this field to skew strike recommendations. The "
            "model's raw P(up) is in p_up_raw, wired to nothing. volAmp and the "
            "barrier levels in noctua.json ARE validated."
        ),
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Run one NOCTUA forecast")
    p.add_argument("--weights", type=Path, default=None,
                   help="explicit weights file; defaults to v2 if present, else v1")
    p.add_argument("--out-dir", type=Path, default=Path("data"))
    p.add_argument("--offline", action="store_true",
                   help="use the committed history bundle only, no network fetch")
    p.add_argument("--anchor", type=int, help="unix ts of the anchor hour")
    p.add_argument("--H", type=int, default=PROD_H)
    a = p.parse_args(argv)

    # Prefer the v2 committee artifact; fall back to v1 if it is absent. The
    # runtime is chosen from the artifact's own metadata, not its filename.
    model = load_model(a.weights)
    print(f"[predict] model = {model.meta.get('version', 'NOCTUA-v1')} "
          f"({model.meta.get('n_params_total', model.meta.get('n_params')):,} params)")
    if a.offline:
        hours, src = load_bundle(), "offline:bundle"
    else:
        hours, info = get_hours(fetch_bars)
        src = info["source"]

    _MODEL_TAG[0] = model.meta.get("version", "NOCTUA-v1")
    f = forecast(model, hours, H=a.H, anchor_ts=a.anchor, source=src)
    legacy = to_legacy(f)

    a.out_dir.mkdir(parents=True, exist_ok=True)
    (a.out_dir / "noctua.json").write_text(json.dumps(f, indent=2) + "\n")
    (a.out_dir / "kronos.json").write_text(json.dumps(legacy, indent=2) + "\n")

    print(json.dumps(f, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
