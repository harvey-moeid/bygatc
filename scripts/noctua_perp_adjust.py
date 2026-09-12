#!/usr/bin/env python3
"""
scripts/noctua_perp_adjust.py
=====================================================================
Ambil prediksi NOCTUA live (dihitung dari spot BTCUSD @ Bitstamp) dan
sesuaikan (basis-adjusted) ke harga BTCUSDT perpetual futures, supaya
level barrier / safe-strike bisa langsung dipakai sebagai acuan
SL/TP di instrumen yang benar-benar Anda trading.

CATATAN PENTING:
- NOCTUA sengaja TIDAK punya skill arah di horizon ini (p_up ~ coin
  flip). Jangan pakai script ini untuk sinyal entry LONG/SHORT.
  Yang berguna adalah kurva volatilitas & barrier survival untuk
  penempatan level (SL/TP) dan sizing, bukan arah.
- Basis (perp vs spot) biasanya kecil (funding-driven), tapi bisa
  melebar saat funding ekstrem / dislokasi pasar. Script ini hanya
  menggeser level linear sebesar basis saat ini -- bukan model baru.

KENAPA INI BELUM DIOTOMATISASI DI noctua-predict.yml:
GitHub Actions hosted runner ada di region Azure US, dan Binance
mem-block IP US untuk endpoint publik (HTTP 451). Ini masalah yang
sama persis yang sudah didokumentasikan di serve/fetch.py soal fallback
Binance yang harus diganti ke Coinbase. Kalau mau otomatis lewat CI,
perlu (a) proxy/relay di luar Azure US, atau (b) pindah sumber data
perp ke exchange yang tidak geo-block dari runner (mis. Bybit/OKX,
perlu dicek satu-satu), atau (c) panggil dari sisi Cloudflare Worker
(edge, bukan Azure US) lewat endpoint API baru -- tapi region keluar
Worker tidak dijamin konsisten dan perlu diverifikasi dulu sebelum
dipakai produksi. Untuk sekarang script ini dijalankan manual/lokal.

Pakai:
    pip install requests   # opsional, urllib bawaan sudah cukup
    python scripts/noctua_perp_adjust.py
"""
from __future__ import annotations

import json
import sys
import urllib.request

NOCTUA_URL = "https://btc-dashboard-worker-production.harveymoeid.workers.dev/api/noctua/latest"
BINANCE_PERP_URL = "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT"


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "noctua-perp-adjust/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def fetch_noctua() -> dict:
    """Prediksi terbaru dari Worker KV (sudah dihitung tiap 30 menit via GH Actions)."""
    return _get_json(NOCTUA_URL)


def fetch_perp_mark() -> dict:
    """Mark price + index price + funding rate BTCUSDT perpetual dari Binance Futures."""
    d = _get_json(BINANCE_PERP_URL)
    return {
        "mark_price": float(d["markPrice"]),
        "index_price": float(d["indexPrice"]),
        "last_funding_rate": float(d["lastFundingRate"]),
        "next_funding_time": d["nextFundingTime"],
    }


def adjust(noctua: dict, perp: dict) -> dict:
    spot = noctua["spot"]
    basis = perp["mark_price"] - spot
    basis_pct = 100 * basis / spot

    def shift(price: float) -> float:
        return round(price + basis, 2)

    safe_levels = [
        {**lvl, "call_strike_perp": shift(lvl["call_strike"]),
         "put_strike_perp": shift(lvl["put_strike"])}
        for lvl in noctua["safe_levels"]
    ]
    barrier_curves = {
        side: [{**b, "price_perp": shift(b["price"])} for b in curve]
        for side, curve in noctua["barrier_curves"].items()
    }

    return {
        "spot_btcusd": spot,
        "perp_mark_btcusdt": perp["mark_price"],
        "basis_usd": round(basis, 2),
        "basis_pct": round(basis_pct, 4),
        "last_funding_rate_pct": round(100 * perp["last_funding_rate"], 4),
        "p_up_raw_no_edge": noctua["p_up_raw"],  # ingat: bukan sinyal arah
        "sigma_window_pct": noctua["sigma_window_pct"],
        "settle_utc": noctua["settle_utc"],
        "safe_levels_perp": safe_levels,
        "barrier_curves_perp": barrier_curves,
        "warning": (
            "Arah (p_up) tidak punya skill -- jangan dipakai untuk entry. "
            "Gunakan sigma & barrier curve untuk SL/TP dan sizing berbasis volatilitas."
        ),
    }


def main() -> int:
    try:
        noctua = fetch_noctua()
        perp = fetch_perp_mark()
    except Exception as e:  # noqa: BLE001
        print(f"[error] gagal fetch data: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    out = adjust(noctua, perp)

    print(f"Spot BTCUSD (Bitstamp) : ${out['spot_btcusd']:,.2f}")
    print(f"Perp mark BTCUSDT      : ${out['perp_mark_btcusdt']:,.2f}")
    print(f"Basis (perp - spot)    : ${out['basis_usd']:,.2f}  ({out['basis_pct']:.4f}%)")
    print(f"Funding rate terakhir  : {out['last_funding_rate_pct']:.4f}%")
    print(f"Settle window (UTC)    : {out['settle_utc']}")
    print(f"Sigma window           : {out['sigma_window_pct']:.3f}%")
    print()
    print("Safe strike levels (basis-adjusted ke BTCUSDT.P):")
    for lvl in out["safe_levels_perp"]:
        print(f"  alpha={lvl['alpha']:<5} call={lvl['call_strike_perp']:>10,.2f}"
              f"   put={lvl['put_strike_perp']:>10,.2f}")
    print()
    print("Barrier touch probability (naik):")
    for b in out["barrier_curves_perp"]["up"]:
        print(f"  +{b['pct']:>4}%  price_perp={b['price_perp']:>10,.2f}"
              f"   touch_prob={b['touch_prob']:.4f}")
    print("Barrier touch probability (turun):")
    for b in out["barrier_curves_perp"]["dn"]:
        print(f"  {b['pct']:>5}%  price_perp={b['price_perp']:>10,.2f}"
              f"   touch_prob={b['touch_prob']:.4f}")
    print()
    print(f"[!] {out['warning']}")

    with open("noctua_perp_adjusted.json", "w") as f:
        json.dump(out, f, indent=2)
    print("\nDisimpan ke noctua_perp_adjusted.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
