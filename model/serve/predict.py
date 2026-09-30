"""NOCTUA production forecast: live bars -> features -> model -> JSON + data exports."""
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

from noctua.features import build_features
from serve.adaptive import apply_correction, volatility_correction
from serve.fetch import fetch_bars
from serve.history import get_hours, load_bundle, save_bundle
from serve.runtime import load_model

_MODEL_TAG = ["NOCTUA-v1"]

PROD_H = 19
PROD_ANCHOR_UTC = 17
ALPHAS = (0.01, 0.02, 0.05, 0.10, 0.20)
BARRIER_GRID_PCT = (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.5, 10.0)


def _next_anchor(now_ts: int) -> int:
    dt = datetime.fromtimestamp(now_ts, timezone.utc)
    anchor = dt.replace(hour=PROD_ANCHOR_UTC, minute=0, second=0, microsecond=0)
    return int(anchor.timestamp())


def forecast(model, hours: pd.DataFrame, H: int = PROD_H,
             anchor_ts: int | None = None, source: str = "unknown") -> dict:
    hour_ts = hours["hour_ts"].to_numpy(np.int64)

    if anchor_ts is None:
        anchor_ts = int(hour_ts[-1])
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

    cal = volatility_correction(model, hours, row, H)
    if cal["applied"]:
        pred = apply_correction(pred, cal["factor"])

    spot = float(hours["close"].to_numpy()[row - 1])
    sigma = float(pred["sigma_med"][0])

    rv5 = hours["rv5"].to_numpy(np.float64)
    trailing = float(np.sqrt(rv5[row - H:row].sum()))
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
    qa = pred["qa"][0]
    H = pred["H"][0]
    tot = np.exp(qa) * np.sqrt(H)
    return float(1.0 - np.interp(threshold, tot, model.levels, left=0.0, right=1.0))


def to_legacy(f: dict) -> dict:
    now_ms = int(time.time() * 1000)
    source_ms = int(pd.Timestamp(f["anchor_utc"]).timestamp() * 1000)
    age_hours = max(0.0, (now_ms - source_ms) / 3_600_000.0)
    return {
        "upside": 50.0,
        "p_up_raw": round(100 * f["p_up"], 1),
        "volAmp": round(100 * f["p_vol_amplify"], 1),
        "sourceTs": f["anchor_utc"][:19],
        "sourceMs": source_ms,
        "tz": "UTC",
        "ageHrs": round(age_hours, 3),
        "freshness": "fresh" if age_hours <= 2 else ("stale" if age_hours <= 6 else "expired"),
        "fetchedAt": now_ms,
        "proxy": "noctua-local",
        "_updatedMs": now_ms,
        "model": f.get("model", _MODEL_TAG[0]),
        "upside_is_informative": False,
        "warning": "upside is pinned to 50.0; use volAmp and NOCTUA barrier levels for validated output.",
    }


def export_history(hours: pd.DataFrame, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    parquet = out_dir / "noctua_history.parquet"
    csv = out_dir / "noctua_history.csv"
    hours.to_parquet(parquet, index=False, compression="zstd")
    hours.to_csv(csv, index=False)
    return parquet, csv


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Run one NOCTUA forecast")
    p.add_argument("--weights", type=Path, default=None)
    p.add_argument("--out-dir", type=Path, default=Path("data"))
    p.add_argument("--offline", action="store_true")
    p.add_argument("--anchor", type=int)
    p.add_argument("--H", type=int, default=PROD_H)
    a = p.parse_args(argv)

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
    (a.out_dir / "BGTC.json").write_text(json.dumps(legacy, indent=2) + "\n")
    export_history(hours, a.out_dir)

    print(json.dumps(f, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
