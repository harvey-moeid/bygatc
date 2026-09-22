# Alur Baca Data  ->  Menghasilkan Trade

Dokumen ini menjelaskan pipeline end-to-end sistem BTC Dashboard: dari data mentah sampai keluar rekomendasi trade di UI.

---

## Daftar Isi

- [1. Ingest Data Mentah](#1-ingest-data-mentah-python-dijadwalkan-via-github-actions)
- [2. Bangun Fitur](#2-bangun-fitur)
- [3. Jalankan Model NOCTUA](#3-jalankan-model-noctua)
- [4. Publish Hasil](#4-publish-hasil)
- [5. Frontend Ambil & Gabungkan Sinyal](#5-frontend-ambil--gabungkan-sinyal)
- [6. Bangun Rencana Trade (Opsi)](#6-bangun-rencana-trade-opsi)
- [7. Keputusan Akhir (Opsi)](#7-keputusan-akhir-opsi)
- [8. Relevansi untuk Futures BTCUSDT.P](#8-relevansi-untuk-futures-btcusdtp)

---

## 1. Ingest Data Mentah (Python, dijadwalkan via GitHub Actions)

- **`model/serve/fetch.py`**  ->  `fetch_bars()`: ambil bar harga BTC terbaru (candle per jam) dari exchange.
- **`model/serve/history.py`**  ->  `get_hours()`: gabungkan history yang sudah ter-commit (bundle) dengan tail data baru dari fetch, menjadi satu deret jam-an yang panjang. Minimal butuh 365 hari ke belakang karena ada fitur (`reg_rv_vs_year`) yang melihat sejauh itu  -  history yang terlalu pendek akan diam-diam fallback ke rata-rata training, bukan error.

## 2. Bangun Fitur

- **`model/noctua/features.py`**  ->  `build_features()`: dari deret jam-an, dihitung fitur untuk satu titik anchor (jam terakhir yang closed)  -  realized volatility, jam-dalam-hari, hari-dalam-minggu, dan fitur lain yang dipakai model.

## 3. Jalankan Model NOCTUA

- **`model/serve/runtime.py`**  ->  `load_model()`: load bobot model (prioritas `noctua_v2.npz`, fallback ke v1).
- **`model/serve/predict.py`**  ->  `forecast()`:
  1. Model memprediksi **sigma** (estimasi volatilitas window ke depan, horizon `H = 19` jam) dalam bentuk kuantil.
  2. **Koreksi kalibrasi** diterapkan (`model/serve/adaptive.py`  ->  `volatility_correction`) karena model historisnya bias ketinggian (realized vol berada di bawah forecast 66.4% dari waktu). Koreksi ini dihitung hanya dari episode yang sudah settle, jadi tidak ada look-ahead bias.
  3. Dari sigma yang sudah dikoreksi, dihitung:
     - `p_up`  ->  probabilitas arah naik. **Ditandai eksplisit tidak reliable**: walk-forward log-loss-nya (0.6941) nyaris sama dengan lempar koin (0.6931).
     - `p_vol_amplify`  ->  probabilitas realized vol > vol historis (trailing RV). **Ini tervalidasi**: beda 2.79% QLIKE vs baseline Log-HAR (p = 0.043, 5/6 walk-forward folds).
     - `barrier_curves`  ->  probabilitas harga menyentuh level tertentu (grid +/-0.5% s/d +/-10%), dipecah sisi naik (`up`) dan turun (`dn`), masing-masing berisi `{ pct, price, touch_prob }` per level.
     - `safe_levels`  ->  strike call/put "aman" secara statistik untuk beberapa alpha (1%, 2%, 5%, 10%, 20%).

## 4. Publish Hasil

- Dua file JSON ditulis oleh `predict.py`:
  - `noctua.json`  ->  payload lengkap dan jujur (semua angka di atas apa adanya).
  - `kronos.json`  ->  dibentuk lewat `to_legacy()`, kompatibel dengan format lama yang dikonsumsi frontend. Field `upside` **sengaja dipin ke 50.0**  -  bukan diisi `p_up` mentah  -  supaya sinyal arah yang tidak tervalidasi tidak dipakai untuk menggeser strike. Nilai mentah tetap dipublikasikan terpisah sebagai `p_up_raw`.
- `model/serve/merge_payload.py` **menggabungkan** `noctua.json` + `kronos.json` menjadi satu payload sebelum dikirim ke Worker  -  jadi payload yang benar-benar sampai ke KV/browser berisi *keduanya*: field legacy (`upside`, `volAmp`, `freshness`) **dan** field lengkap (`p_up_raw`, `p_vol_amplify`, `barrier_curves`, `safe_levels`, `sigma_annualized_pct`, dll). Ini penting untuk bagian futures di bawah.
- Workflow `.github/workflows/noctua-predict.yml` menjalankan `predict.py` tiap 30 menit, lalu POST hasilnya ke `POST /api/noctua/push` (Worker), divalidasi dengan header `Authorization: Bearer <NOCTUA_PUSH_SECRET>`.
- Worker (`apps/worker/src/routes/noctua.ts`) menyimpan payload gabungan ke KV (`BTC_CACHE`, key `noctua:latest`, TTL 26 jam) dan mengekspos `GET /api/noctua/latest` untuk dibaca browser.

## 5. Frontend Ambil & Gabungkan Sinyal

- `apps/frontend/src/data.js`  ->  `fetchKronos()`: ambil `/api/noctua/latest` dari Worker (fallback ke snapshot `./data/kronos.json` kalau Worker gagal).
- Sinyal lain di-fetch paralel:
  - Harga & candle (`fetchPrice`, `fetchHourly`, `fetchDaily`)
  - HV20  -  realized vol 20 hari, dihitung sendiri di frontend dari `computeHV20()`
  - Funding rate perpetual (`fetchFunding`)
  - IV dari Deribit option chain, ATM strike terdekat (`findAtmIv`)
  - Fear & Greed index (`fetchFearGreed`)
  - News sentiment (`fetchNewsSentiment`, `scoreSentiment`)
  - Konteks sesi/waktu (`computeSessionContext`, berbasis jam IST)
- `classifyRegime(atmIv, hv20)`: bandingkan IV vs HV20  ->  tentukan regime (CALM/NORMAL/CAUTION/REDUCED/NO-TRADE) berdasarkan threshold rasio 1.2/1.4/1.6/1.8.

## 6. Bangun Rencana Trade (Opsi)

- `buildRetailPlan()`: kalau regime mengizinkan & arah dari Kronos cukup jelas (bukan 50/50), cari strike OTM yang preminya cukup untuk membiayai struktur (long straddle ATM + short OTM options), dan touch probability-nya di bawah threshold.
- **Catatan:** fungsi ini murni untuk strategi jual premi opsi di Deribit. Tidak dipakai, dan tidak dimaksudkan dipakai, untuk futures  -  lihat section8.

## 7. Keputusan Akhir (Opsi)

- `buildDecision()`: gabungkan semua blocker (regime, session, funding ekstrem, Kronos stale, arah tidak jelas) jadi satu verdict: **TRADE OK / CAUTION / WAIT / NO-TRADE**, plus skor confidence dan struktur trade yang direkomendasikan (misal: "1 long straddle $X + 60 short $Y puts").
- Ini yang dirender di hero card (`ui.js`  ->  `updateHero`, `updateRetailPlan`).

---

## 8. Relevansi untuk Futures BTCUSDT.P

section6 dan section7 di atas (`buildRetailPlan`, `buildDecision`, regime IV/HV20) dirancang khusus untuk **strategi jual premi opsi** dan tidak berlaku langsung untuk futures perpetual, yang inherently directional (harus pilih long atau short) dan tidak melibatkan premi opsi sama sekali.

Untuk futures, bagian pipeline yang **relevan** adalah komponen NOCTUA yang tervalidasi (`p_vol_amplify`, `barrier_curves`) plus funding  -  dipakai untuk **manajemen risiko**, bukan untuk memilih arah. Ini diimplementasikan di `apps/frontend/src/data.js`  ->  **`buildFuturesPlan()`**.

### Kenapa arah tetap harus dari luar model

`p_up`/`upside` tidak punya validated directional skill di horizon ini (log-loss 0.6941 vs 0.6931 coin flip  -  section3). `buildFuturesPlan()` karena itu **mewajibkan parameter `direction` (`'long'`/`'short'`) dari pemanggil**  -  dari thesis/TA sendiri, bukan dari Kronos. Kalau tidak diisi, fungsi menolak dengan `ok: false` dan alasan eksplisit.

### Apa yang dihitungkan fungsi ini

| Input | Sumber | Dipakai untuk |
|---|---|---|
| `barrier_curves.up` / `.dn` | NOCTUA (tervalidasi secara tidak langsung  -  turunan dari sigma forecast) | Pilih level SL (touch probability  35%) dan TP (touch probability  20%) berdasarkan sisi yang sesuai arah |
| `p_vol_amplify` | NOCTUA (tervalidasi langsung, section3) | Kecilkan ukuran posisi saat probabilitas ekspansi volatilitas tinggi  -  makin besar `p_vol_amplify`, makin besar risiko kena stop-out dari lonjakan harga |
| `funding.flag` | Worker `/market/funding` | Kecilkan ukuran posisi lagi kalau funding ekstrem **searah** posisi (mis. funding sangat positif + long = crowded, mahal ditahan, rawan squeeze) |
| `hv20.oneDay` | `computeHV20()` (fallback) | Kalau `barrier_curves` tidak tersedia di payload, SL/TP didekati dari kelipatan pergerakan harian HV20 |

### Output

```js
DataLayer.buildFuturesPlan({
  price, direction: 'long',   // dari TA/thesis sendiri
  hv20, kronos, funding,
  accountEquity: 10000, riskPct: 1,
});
// => {
//   ok: true, direction: 'long',
//   entryPrice, stopLoss, takeProfit,
//   stopDistancePct, tpDistancePct, riskRewardRatio,
//   slTouchProb, tpTouchProb, usedBarrierCurves,
//   pVolAmplify, sizeMultiplier,
//   riskAmount, positionNotional,
//   warnings: [...], note: '...'
// }
```

### Keterbatasan yang perlu diperhatikan

- **Horizon tetap H = 19 jam.** `barrier_curves` dihitung untuk window itu, bukan untuk periode holding futures kamu. Kalau kamu berencana menahan posisi jauh lebih lama atau lebih singkat dari ~19 jam, touch probability yang dipakai untuk SL/TP tidak lagi presisi  -  anggap sebagai perkiraan, bukan angka pasti.
- **`p_vol_amplify` adalah probabilitas, bukan magnitude.** Ia bilang "kemungkinan vol lebih tinggi dari trailing RV", bukan seberapa jauh. Sizing yang dipakai (`1 - p_vol_amplify * 0.6`) adalah heuristik sederhana, bukan hasil optimasi.
- **Tidak ada komponen likuidasi.** Fungsi ini menghitung SL/TP berbasis persentase harga, bukan leverage/margin akun kamu. Jarak liquidation price di exchange kamu bisa lebih dekat dari SL yang dihitung di sini  -  selalu cek margin ratio di exchange secara terpisah.
- **Funding di sistem ini hanya dipakai sebagai flag ekstrem** (long-extreme/short-extreme), bukan dilacak sebagai biaya kumulatif kalau posisi ditahan lintas beberapa periode funding (tiap 8 jam).

---

## Ringkasan

```
NOCTUA (vol forecast: p_vol_amplify, barrier_curves)
         v 
         Opsi (jual premi):  + IV/HV20 regime + touch prob   ->  buildRetailPlan() + buildDecision()
        
         Futures (BTCUSDT.P): + funding + arah dari luar   ->  buildFuturesPlan()
```

Model Python (NOCTUA) **hanya** menyuplai estimasi volatilitas dan probabilitas barrier yang sudah divalidasi lewat walk-forward testing  -  sinyal arah (`upside`) sengaja dinetralkan karena tidak terbukti punya skill prediktif, di kedua jalur (opsi maupun futures) di atas.