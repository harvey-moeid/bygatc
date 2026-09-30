# Public API - bygatc (BTC Dashboard)

Base URL: `https://<worker-subdomain>.workers.dev` (lihat URL Worker production kamu).

Semua endpoint GET di bawah ini bebas diakses lintas domain (CORS terbuka
untuk semua origin) karena datanya publik (harga pasar, prediksi, news).
Endpoint tulis (`POST`/`PUT`) tetap butuh `Authorization: Bearer <secret>`
dan tidak dimaksudkan untuk dipanggil dari web konsumen.

Gunakan prefix `/api/v1/...` di web eksternal kamu, bukan `/api/...` polos.
Prefix tanpa versi tetap ada untuk kompatibilitas dashboard internal, tapi
`/api/v1/*` adalah kontrak yang dijamin stabil (tidak akan ada breaking
change tanpa naik ke `/api/v2/*`).

## Discovery

```
GET /api
```
Daftar semua endpoint yang tersedia, dalam format JSON.

```
GET /api/health
```
Health check sederhana (`{ ok, ts, env, noctuaData }`). Tidak di-cache.

## Market data

| Endpoint | Deskripsi | Cache | Sumber (urutan fallback) |
|---|---|---|---|
| `GET /api/v1/market/price` | Harga spot BTC/USDT terkini (price, high, low, change, volume) | 60s | Binance -> Crypto.com -> OKX |
| `GET /api/v1/market/hourly` | 48 candle terakhir, interval 1 jam | 300s | Binance -> Bybit -> Crypto.com -> OKX |
| `GET /api/v1/market/daily` | 60 candle terakhir, interval 1 hari | 3600s | Binance -> Bybit -> Crypto.com -> OKX |
| `GET /api/v1/market/funding` | Funding rate futures BTC | 600s | Binance -> Bybit -> OKX |
| `GET /api/v1/market/options` | Ringkasan option chain BTC | 600s (header `X-Data-Freshness: stale` kalau fallback) | Deribit saja + cache stale 24 jam sebagai jaring pengaman (lihat catatan di bawah) |

Field `source` di response `/price` dan `/funding` menunjukkan exchange mana
yang benar-benar dipakai untuk request itu (`binance`, `bybit`, `crypto.com`,
atau `okx`) -- berguna kalau kamu mau tahu data lagi dari primary atau lagi
failover.

Semua route punya failover otomatis antar-exchange seperti tabel di atas.
Kalau semua sumber di rantai itu gagal, response `503 { "error": "... unavailable" }`.

**Kenapa `/options` tidak punya fallback exchange lain:** satu-satunya
alternatif publik yang sepadan (OKX `public/opt-summary`) cuma balikin
implied volatility & Greeks per kontrak -- tidak ada open interest, volume,
atau mark price dalam USD seperti Deribit. Daripada memetakannya ke shape
yang sama dengan field-field itu diisi `0` (yang bisa bikin semua strike
terlihat illiquid), endpoint ini tetap 100% Deribit dan jatuh ke salinan
cache 24 jam terakhir (`market:options_stale`) kalau Deribit lagi down.

## Enrichment

| Endpoint | Deskripsi | Cache |
|---|---|---|
| `GET /api/v1/enrichment/news` | Berita terkait BTC, diperbarui tiap jam lewat cron | 1800s |
| `GET /api/v1/enrichment/fg` | Fear & Greed Index | 1800s |

Kalau data belum pernah di-fetch (KV kosong), response `503` dan proses
fetch dipicu di background -- retry setelah ~30 detik.

## NOCTUA (model prediksi)

| Endpoint | Deskripsi | Cache |
|---|---|---|
| `GET /api/v1/noctua/latest` | Prediksi terbaru dari model NOCTUA, diperbarui tiap ~30 menit oleh GitHub Actions | 120s |
| `GET /api/v1/noctua/data` | Metadata file history (parquet/csv): ukuran, waktu upload, etag | 300s |
| `GET /api/v1/noctua/download?format=parquet\|csv` | Download file history lengkap | 300s |

## Contoh pemakaian dari web lain

```js
async function getBtcPrice() {
  const res = await fetch('https://<worker-subdomain>.workers.dev/api/v1/market/price');
  if (!res.ok) throw new Error(`price fetch failed: ${res.status}`);
  return res.json();
}
```

Tidak perlu API key untuk endpoint di atas. Karena CORS sudah terbuka,
fetch bisa dipanggil langsung dari browser di domain manapun.

## Rate limiting

Saat ini belum ada rate limiting di level kode. Kalau salah satu web
konsumen mulai memukul endpoint ini terlalu sering (mis. polling tiap
detik), pasang **Cloudflare Rate Limiting Rule** di dashboard Cloudflare
pada zone Worker ini (bukan sesuatu yang bisa diatur lewat repo). Karena
hampir semua endpoint sudah di-cache di KV dan sekarang juga kirim header
`Cache-Control`, beban ke Worker seharusnya tetap rendah walau dipanggil
dari banyak web sekaligus.

## Versi & perubahan breaking

- `/api/v1/*` -- kontrak stabil, aman diandalkan oleh web eksternal.
- `/api/*` (tanpa versi) -- alias yang sama, dipertahankan untuk
  kompatibilitas mundur, tapi sebaiknya web baru langsung pakai `/api/v1/*`.
- Kalau nanti ada perubahan shape response yang breaking, akan ditambahkan
  `/api/v2/*` baru, `/api/v1/*` tidak akan diubah.
