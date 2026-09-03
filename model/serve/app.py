"""
serve/app.py
=====================================================================
Hugging Face Space entrypoint (free tier: 2 vCPU / 16 GB).

Serves:
    /                 a small dark status UI
    /api/kronos       LEGACY shape -- drop-in for the dead Kronos demo scrape,
                      so src/data.js keeps working with no changes
    /api/noctua       the real product: barrier survival curves + safe strikes
    /api/health       liveness + model metadata

Resource profile: NumPy + SciPy only (no PyTorch), sub-millisecond per
forecast on the v2 artifact (19,134 parameters, ~98 KB). The forecast is
recomputed at most once every REFRESH_SEC and served from cache otherwise, so
the Space spends essentially all of its time idle.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import gradio as gr                                            # noqa: E402
from fastapi.responses import JSONResponse                     # noqa: E402

from serve.fetch import fetch_bars                             # noqa: E402
from serve.history import get_hours                            # noqa: E402
from serve.predict import forecast, to_legacy                  # noqa: E402
from serve.runtime import load_model                           # noqa: E402

REFRESH_SEC = int(os.environ.get("NOCTUA_REFRESH_SEC", "1800"))

# Whichever artifact is present, newest first -- NOT a hardcoded v1 path. The
# Space quietly served v1 while the Action served v2 for as long as this line
# constructed NumpyNoctua itself.
_model = load_model()
_N_PARAMS = _model.meta.get("n_params_total", _model.meta.get("n_params", 0))
_lock = threading.Lock()
_cache: dict = {"forecast": None, "legacy": None, "ts": 0.0, "error": None}


def get_forecast(force: bool = False) -> dict:
    with _lock:
        fresh = _cache["forecast"] is not None and (time.time() - _cache["ts"]) < REFRESH_SEC
        if fresh and not force:
            return _cache
        try:
            # `forecast` runs on the MERGED HOURLY frame (committed bundle +
            # live tail), not on raw 5-minute bars. Passing fetch_bars() straight
            # through raised KeyError('hour_ts') into the handler below, so the
            # Space served "no forecast yet" indefinitely. persist=False: the
            # Space's filesystem is ephemeral and is not the bundle's home.
            hours, info = get_hours(fetch_bars, persist=False, verbose=False)
            f = forecast(_model, hours, source=info["source"])
            _cache.update(forecast=f, legacy=to_legacy(f), ts=time.time(), error=None)
        except Exception as e:  # noqa: BLE001
            # keep serving the last good forecast, but say so
            _cache["error"] = f"{type(e).__name__}: {e}"
            traceback.print_exc()
        return _cache


def render() -> str:
    c = get_forecast()
    f = c["forecast"]
    if f is None:
        return f"<p style='color:#f87171'>No forecast yet. {c['error'] or ''}</p>"
    rows = "".join(
        f"<tr><td>{s['alpha']:.0%}</td><td>${s['put_strike']:,.0f}</td>"
        f"<td>{s['put_pct']:+.2f}%</td><td>${s['call_strike']:,.0f}</td>"
        f"<td>{s['call_pct']:+.2f}%</td></tr>"
        for s in f["safe_levels"]
    )
    warn = f"<p style='color:#f87171'>stale: {c['error']}</p>" if c["error"] else ""
    return f"""
    <div style="font-family:ui-monospace,monospace;color:#e7e7f0">
      {warn}
      <p>spot <b>${f['spot']:,.2f}</b> &middot; window <b>{f['H_hours']}h</b>
         &middot; {f['anchor_utc'][:16]} &rarr; {f['settle_utc'][:16]} UTC</p>
      <p>forecast realized vol <b>{f['sigma_window_pct']:.2f}%</b> over the window
         (<b>{f['sigma_annualized_pct']:.0f}%</b> annualized) &middot;
         trailing {f['trailing_rv_pct']:.2f}% &middot;
         P(vol amplifies) <b>{f['p_vol_amplify']:.0%}</b></p>
      <table style="border-collapse:collapse" border="1" cellpadding="6">
        <tr><th>breaks</th><th>put strike</th><th></th><th>call strike</th><th></th></tr>
        {rows}
      </table>
      <p style="opacity:.7;font-size:13px">
        "breaks" = probability the level is TOUCHED at any point before settlement
        (not just finishing beyond it). Direction (p_up = {f['p_up']:.0%}) is
        <b>not</b> a validated signal &mdash; see the README.
      </p>
      <p style="opacity:.6;font-size:12px">source: {f['source']} &middot;
         educational research only, not financial advice</p>
    </div>"""


with gr.Blocks(title="NOCTUA — BTC overnight barrier model", theme=gr.themes.Base()) as demo:
    gr.Markdown("## NOCTUA — BTC overnight option-seller's barrier model")
    gr.Markdown(
        f"{_N_PARAMS:,} parameters ({_model.meta.get('version', 'NOCTUA-v1')}). "
        "Predicts, for the 19-hour window from 17:00 UTC "
        "(22:30 IST) to 12:00 UTC (17:30 IST) next day, **which levels are strong "
        "enough not to break**."
    )
    out = gr.HTML(render)
    gr.Button("Refresh").click(lambda: render(), outputs=out)

app = demo.app


@app.get("/api/kronos")
def api_kronos():
    c = get_forecast()
    if c["legacy"] is None:
        return JSONResponse({"error": c["error"] or "no forecast yet"}, status_code=503)
    return JSONResponse(c["legacy"])


@app.get("/api/noctua")
def api_noctua():
    c = get_forecast()
    if c["forecast"] is None:
        return JSONResponse({"error": c["error"] or "no forecast yet"}, status_code=503)
    return JSONResponse(c["forecast"])


@app.get("/api/health")
def api_health():
    return JSONResponse({
        "ok": True,
        "model": _model.meta.get("version", "NOCTUA-v1"),
        "params": _N_PARAMS,
        "blend_w": _model.blend_w,
        "cal_shrink": _model.cal_shrink,
        "cache_age_sec": round(time.time() - _cache["ts"], 1) if _cache["ts"] else None,
        "last_error": _cache["error"],
    })


if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=int(os.environ.get("PORT", 7860)))
