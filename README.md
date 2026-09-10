# BTC Dashboard — Cloudflare Edition

Dashboard prediksi harga BTC. Frontend di **Cloudflare Pages**, backend di **Cloudflare Worker + KV**, model prediksi (NOCTUA) jalan periodik lewat **GitHub Actions**.

---

## Daftar Isi

- [Arsitektur](#arsitektur)
- [Struktur Repo](#struktur-repo)
- [Setup Awal](#setup-awal)
- [Dev Lokal](#dev-lokal)
- [Cek Status](#cek-status)
- [Troubleshooting](#troubleshooting)
- [Catatan Developer](#catatan-developer)

---

## Arsitektur

```
Browser  →  Cloudflare Pages (HTML/JS)
               → /api/*
               ↓
         Cloudflare Worker  →  KV Cache
               → scheduled
               ↓
         Cron Trigger (setiap jam)  →  fetch news, fear & greed
               ↓
               ↓
         GitHub Actions (setiap 30 menit)  →  Python NOCTUA model
               → POST /api/noctua/push
               ↓
         Worker KV
```

Alur singkat:
1. Worker punya cron trigger tiap jam untuk fetch data eksternal (news, fear & greed index) dan simpan ke KV.
2. GitHub Actions menjalankan model Python NOCTUA tiap 30 menit, lalu push hasil prediksi ke Worker lewat endpoint `/api/noctua/push` (divalidasi pakai `NOCTUA_PUSH_SECRET`).
3. Frontend statis di Cloudflare Pages memanggil `/api/*` di Worker untuk menampilkan data terbaru.

---

## Struktur Repo

```
.
├── .github/workflows/     # CI: deploy-worker.yml, noctua-predict.yml
├── apps/
│   ├── frontend/          # Static site (HTML/JS), deploy ke Cloudflare Pages
│   └── worker/            # Cloudflare Worker (API + cron)
├── data/                  # Data pendukung
├── model/                 # Model Python NOCTUA (serve/predict.py, dll)
├── scripts/                # Script bantu
├── package.json           # Root workspace (Turborepo + pnpm)
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

Ini pnpm monorepo yang dikelola dengan **Turborepo**.

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
# Secret untuk validasi push dari GitHub Actions
echo "isi-secret-acak-panjang" | pnpm wrangler secret put NOCTUA_PUSH_SECRET --env production

# Optional: Exa API key untuk kualitas news lebih baik
echo "exa-api-key-kamu" | pnpm wrangler secret put EXA_API_KEY --env production
```

### 3. Deploy Worker

Dari root repo:

```bash
pnpm deploy:worker:production
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
/api/*  https://btc-dashboard-worker-production.YOUR_SUBDOMAIN.workers.dev/api/:splat  200
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

Secret-secret ini dipakai oleh workflow `.github/workflows/deploy-worker.yml` dan `.github/workflows/noctua-predict.yml`.

### 7. Pastikan file model Python ada

```
model/serve/predict.py
model/serve/requirements-ci.txt
```

(Salin dari repo lama — tidak ada perubahan di Python model.)

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

Override `WORKER_BASE` supaya frontend lokal manggil Worker lokal, bukan production. Tambahkan di browser console:

```js
window.WORKER_BASE = 'http://localhost:8787/api'
```

Atau taruh langsung di `index.html`, sebelum `<script src="src/data.js">`.

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

## Troubleshooting

| Gejala | Kemungkinan Penyebab | Solusi |
|---|---|---|
| `/api/health` gagal / 404 | Worker belum ter-deploy atau `_redirects` salah URL | Cek `pnpm deploy:worker:production` sukses, cocokkan URL di `apps/frontend/_redirects` |
| `/api/enrichment/news` kosong | Cron trigger belum pernah jalan | Tunggu siklus cron pertama (tiap jam), atau trigger manual lewat Cloudflare dashboard |
| `/api/noctua/latest` kosong / stale | GitHub Actions gagal push, atau `NOCTUA_PUSH_SECRET` tidak cocok | Cek log workflow `noctua-predict.yml`, pastikan secret di GitHub sama dengan yang di-set di Worker |
| Push dari GH Actions ditolak (401/403) | `NOCTUA_PUSH_SECRET` beda antara GitHub Secrets dan Worker secret | Set ulang secret di kedua sisi dengan nilai yang sama |
| Frontend lokal manggil production, bukan local Worker | `window.WORKER_BASE` belum di-override | Set `window.WORKER_BASE = 'http://localhost:8787/api'` sebelum script frontend dimuat |
| `wrangler kv namespace create` gagal | Belum login / token CF salah scope | Jalankan `pnpm wrangler login`, pastikan token punya scope Workers Edit + KV Edit |

---

## Catatan Developer

- Root workspace pakai **Turborepo** (`turbo`) + **pnpm workspaces** — lihat `pnpm-workspace.yaml` untuk daftar package.
- Script utama di root `package.json`:
  - `pnpm dev:worker` — jalankan Worker secara lokal
  - `pnpm deploy:worker:production` — deploy Worker ke production
- CI ada dua workflow di `.github/workflows/`:
  - `deploy-worker.yml` — deploy Worker ke Cloudflare
  - `noctua-predict.yml` — jalankan model Python NOCTUA & push hasil ke Worker KV
- Model Python (NOCTUA) tidak diubah dari repo lama — hanya dipindahkan ke `model/serve/`.
- Data pendukung ada di folder `data/`, script bantu (misalnya migrasi atau utilitas) ada di `scripts/`.
