# Alur Baca Data → Menghasilkan Trade

Dokumen ini menjelaskan pipeline end-to-end sistem BTC Dashboard: dari data mentah sampai keluar rekomendasi trade di UI.

---

## 1. Ingest Data Mentah (Python, dijadwalkan via GitHub Actions)

- **`model/serve/fetch.py`** → `fetch_bars()`: ambil bar harga BTC terbaru (candle per jam) dari exchange.
- **`model/serve/history.py`** → `get_hours()`: gabungkan history yang sudah ter-commit (bundle) dengan tail data baru dari fetch, menjadi satu deret jam-an yang panjang. Minimal butuh 365 hari ke belakang karena ada fitur (`reg_rv_vs_year`) yang melihat sejauh itu — history yang terlalu pendek akan diam-diam fallback ke rata-rata training, bukan error.

## 2. Bangun Fitur

- **`model/noctua/features.py`** → `build_features()`: dari deret jam-an, dihitung fitur untuk satu titik anchor (jam terakhir yang closed) — realized volatility, jam-dalam-hari, hari-dalam-minggu, dan fitur lain yang dipakai model.

## 3. Jalankan Model NOCTUA

- **`model/serve/runtime.py`** → `load_model()`: load bobot model (prioritas `noctua_v2.npz`, fallback ke v1).
- **`model/serve/predict.py`** → `forecast()`:
  1. Model memprediksi **sigma** (estimasi volatilitas window ke depan, horizon `H = 19` jam) dalam bentuk kuantil.
  2. **Koreksi kalibrasi** diterapkan (`model/serve/adaptive.py` → `volatility_correction`) karena model historisnya bias ketinggian (realized vol berada di bawah forecast 66.4% dari waktu). Koreksi ini dihitung hanya dari episode yang sudah settle, jadi tidak ada look-ahead bias.
  3. Dari sigma yang sudah dikoreksi, dihitung:
     - `p_up` — probabilitas arah naik. **Ditandai eksplisit tidak reliable**: walk-forward log-loss-nya (0.6941) nyaris sama dengan lempar koin (0.6931).
     - `p_vol_amplify` — probabilitas realized vol > vol historis (trailing RV). **Ini tervalidasi**: beda 2.79% QLIKE vs baseline Log-HAR (p = 0.043, 5/6 walk-forward folds).
     - `barrier_curves` — probabilitas harga menyentuh level tertentu (grid ±0.5% s/d ±10%).
     - `safe_levels` — strike call/put "aman" secara statistik untuk beberapa alpha (1%, 2%, 5%, 10%, 20%).

## 4. Publish Hasil

- Dua file JSON ditulis oleh `predict.py`:
  - `noctua.json` — payload lengkap dan jujur (semua angka di atas apa adanya).
  - `kronos.json` — dibentuk lewat `to_legacy()`, kompatibel dengan format lama yang dikonsumsi frontend. Field `upside` **sengaja dipin ke 50.0** — bukan diisi `p_up` mentah — supaya sinyal arah yang tidak tervalidasi tidak dipakai untuk menggeser strike. Nilai mentah tetap dipublikasikan terpisah sebagai `p_up_raw`.
- Workflow `.github/workflows/noctua-predict.yml` menjalankan `predict.py` tiap 30 menit, lalu POST hasilnya ke `POST /api/noctua/push` (Worker), divalidasi dengan header `Authorization: Bearer <NOCTUA_PUSH_SECRET>`.
- Worker (`apps/worker/src/routes/noctua.ts`) menyimpan payload ke KV (`BTC_CACHE`, key `noctua:latest`, TTL 26 jam) dan mengekspos `GET /api/noctua/latest` untuk dibaca browser.

## 5. Frontend Ambil & Gabungkan Sinyal

- `apps/frontend/src/data.js` → `fetchKronos()`: ambil `/api/noctua/latest` dari Worker (fallback ke snapshot `./data/kronos.json` kalau Worker gagal).
- Sinyal lain di-fetch paralel:
  - Harga & candle (`fetchPrice`, `fetchHourly`, `fetchDaily`)
  - HV20 — realized vol 20 hari, dihitung sendiri di frontend dari `computeHV20()`
  - Funding rate perpetual (`fetchFunding`)
  - IV dari Deribit option chain, ATM strike terdekat (`findAtmIv`)
  - Fear & Greed index (`fetchFearGreed`)
  - News sentiment (`fetchNewsSentiment`, `scoreSentiment`)
  - Konteks sesi/waktu (`computeSessionContext`, berbasis jam IST)
- `classifyRegime(atmIv, hv20)`: bandingkan IV vs HV20 → klasifikasi regime:

  | Rasio IV/HV20 | Regime | Sizing | Trade diizinkan? |
  |---|---|---|---|
  | < 1.2 | CALM | 100% | Ya |
  | < 1.4 | NORMAL | 70% | Ya |
  | < 1.6 | CAUTION | 40% | Ya |
  | < 1.8 | REDUCED | 20% | Ya |
  | ≥ 1.8 | NO-TRADE | 0% | Tidak |

## 6. Bangun Rencana Trade

- `buildRetailPlan()`:
  1. Cek regime mengizinkan trade.
  2. Tentukan arah (`bullish` / `bearish` / `neutral`) dari `kronosUpside` — kalau neutral (dalam 5% dari 50%), langsung ditolak: "no directional edge".
  3. Cari strike OTM (put kalau bullish, call kalau bearish) yang preminya cukup untuk membiayai struktur (long straddle ATM + short OTM lots), dengan `reqPremPerLot = straddleCost * safetyFactor / shortLots`.
  4. Dari kandidat yang viable secara premium, filter lagi yang `touchProbability()`-nya (berbasis jarak strike / HV20 harian) di bawah threshold (default 10%).
  5. Pilih strike dengan jarak terjauh dari kandidat yang lolos → itu jadi `shortStrike` di rencana akhir.

## 7. Keputusan Akhir

- `buildDecision()` menggabungkan semua sinyal jadi satu verdict:
  - **Blocker** dikumpulkan dari: regime tidak mengizinkan, sesi waktu buruk ("skip"), funding ekstrem, Kronos stale, atau arah tidak jelas (50/50).
  - Verdict:
    - 2+ blocker → **NO-TRADE**
    - 1 blocker → **CAUTION** (kalau plan viable) atau **NO-TRADE**
    - 0 blocker → **TRADE OK** (kalau plan viable) atau **WAIT**
  - Confidence score (0–100) dihitung dari jumlah blocker, sizing regime, dan kejelasan arah Kronos.
  - Struktur trade akhir dirender sebagai teks, misal: `1× long $X straddle + 60× short $Y P`.
- Ini yang muncul di hero decision card (`apps/frontend/src/ui.js` → `updateHero`, `updateRetailPlan`).

---

## Ringkasan

Model Python (NOCTUA) **hanya** menyuplai estimasi volatilitas dan probabilitas barrier yang sudah divalidasi lewat walk-forward testing — sinyal arah (`upside`) sengaja dinetralkan karena tidak terbukti punya skill prediktif. Keputusan trade akhir adalah hasil kombinasi:

```
NOCTUA (vol forecast)  +  IV/HV20 regime  +  funding  +  sesi waktu  +  touch probability
                              │
                              ▼
                    buildDecision() → verdict + struktur trade
```

bukan murni output satu model.
