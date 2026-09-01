# BTC Dashboard — Cloudflare Edition

Frontend di **Cloudflare Pages**, backend di **Cloudflare Worker + KV**.  
Python NOCTUA model tetap di **GitHub Actions** — hasilnya di-push ke Worker KV.

---

## Arsitektur

```
Browser  →  Cloudflare Pages (HTML/JS)
               ↓ /api/*
         Cloudflare Worker  →  KV Cache
               ↑ scheduled
         Cron Trigger (setiap jam)  →  fetch news, fear&greed
               ↑ POST /api/noctua/push
         GitHub Actions (setiap 30 menit)  →  Python NOCTUA model
```

---

## Setup Awal

### 1. Buat KV Namespace

```bash
cd apps/worker
pnpm install
pnpm wrangler kv namespace create BTC_CACHE --env production
pnpm wrangler kv namespace create BTC_CACHE --env staging
```

Salin ID yang muncul ke `wrangler.toml`:
```toml
[[env.production.kv_namespaces]]
id = "PASTE_ID_PRODUCTION_DI_SINI"

[[env.staging.kv_namespaces]]
id = "PASTE_ID_STAGING_DI_SINI"
```

### 2. Set Secrets Worker

```bash
# Secret untuk validasi push dari GH Actions
echo "isi-secret-acak-panjang" | pnpm wrangler secret put NOCTUA_PUSH_SECRET --env production

# Optional: Exa API key untuk kualitas news lebih baik
echo "exa-api-key-kamu" | pnpm wrangler secret put EXA_API_KEY --env production
```

### 3. Deploy Worker

```bash
pnpm deploy:production
```

Catat URL Worker yang muncul, misalnya:
`https://btc-dashboard-worker-production.YOUR_SUBDOMAIN.workers.dev`

### 4. Setup Cloudflare Pages

1. Buka **Cloudflare Dashboard → Pages → Create project**
2. Connect ke repo GitHub ini
3. Build settings:
   - **Build command**: *(kosongkan — static site)*
   - **Build output directory**: `apps/frontend`
4. Setelah deploy, catat URL Pages (misal: `btc-dashboard.pages.dev`)

### 5. Update `_redirects`

Edit `apps/frontend/_redirects`, ganti URL Worker:
```
from = "/api/*"
to = "https://btc-dashboard-worker-production.YOUR_SUBDOMAIN.workers.dev/api/:splat"
```

### 6. Set GitHub Secrets

Di repo settings → Secrets → Actions, tambahkan:

| Secret | Nilai |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token CF (scope: Workers Edit, KV Edit) |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID dari dashboard CF |
| `NOCTUA_PUSH_SECRET` | Secret yang sama dengan step 2 |
| `NOCTUA_WORKER_URL` | URL Worker dari step 3 |
| `EXA_API_KEY` | *(optional)* Exa API key |

### 7. Copy file Python model

Pastikan folder berikut ada di repo:
```
model/serve/predict.py
model/serve/requirements-ci.txt
```
(Salin dari repo lama — tidak ada perubahan di Python model)

---

## Cek Status

```bash
# Health check Worker
curl https://btc-dashboard-worker-production.YOUR_SUBDOMAIN.workers.dev/api/health

# Cek KV news (setelah cron pertama jalan)
curl https://btc-dashboard-worker-production.YOUR_SUBDOMAIN.workers.dev/api/enrichment/news

# Cek NOCTUA prediction (setelah GH Actions pertama jalan)
curl https://btc-dashboard-worker-production.YOUR_SUBDOMAIN.workers.dev/api/noctua/latest
```

---

## Dev Lokal

```bash
# Terminal 1 — jalankan Worker
cd apps/worker && pnpm dev

# Terminal 2 — serve frontend
cd apps/frontend && npx serve .
# buka http://localhost:3000
# Worker jalan di http://localhost:8787
```

Tambahkan di browser console untuk override WORKER_BASE:
```js
window.WORKER_BASE = 'http://localhost:8787/api'
```
Atau tambahkan di `index.html` sebelum `<script src="src/data.js">`.
