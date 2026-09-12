# TODO — `harvey-moeid/btb`

Disusun dari `REVIEW_btb.md` (commit `d370f1b`) + verifikasi ulang terhadap
HEAD saat ini. Yang sudah selesai dicoret dan diberi catatan; sisanya masih
perlu dikerjakan.

> **Update:** ketiga item High priority sudah diperbaiki di commit `cef013a`
> dan `fbab784` (setelah HEAD `c415a13` yang jadi acuan awal TODO ini).
> Dipindah ke bagian "Sudah diperbaiki" di bawah, per verifikasi ulang kode.

---

## 🟡 Medium priority

- [ ] **Mojibake masih tersebar luas — lebih parah dari yang tercatat sebelumnya**
      Masih ada di: `apps/frontend/src/data.js`, `apps/frontend/src/options.js`,
      **dan `README.md`** (termasuk di judul & diagram ASCII-nya sendiri,
      meski sudah ada beberapa commit "fix mojibake" khusus README).
      **Fix:** satu pass bersih UTF-8 di seluruh repo (grep pola
      `Ã¢`, `â`, `Î`, dll), bukan tambal-sulam per file lagi.

- [ ] **`options.html` (desk opsi) pakai arsitektur fetch berbeda dari desk lain**
      `apps/frontend/src/options.js` fetch langsung ke `deribit.com`,
      `api.binance.com`, `fapi.binance.com` dari browser — tanpa failover,
      tanpa cache bersama (beda dengan `index.html`/`futures.html` yang
      lewat Worker `market.ts`, yang sudah punya failover + KV cache).
      **Fix:** unifikasi lewat Worker, atau minimal dokumentasikan
      perbedaan arsitektur ini secara eksplisit.

- [ ] **Kode/aset mati**
  - [ ] `apps/frontend/src/rateLimit.js` — `beginCall`/`canCall`/`record`
        tidak pernah dipanggil (`main.js` cuma pakai `getStats()`), jadi
        panel "Anggaran API" akan selalu tampil 0 pemakaian — menyesatkan.
  - [ ] `<script src="src/config.js" onerror="this.remove()">` di
        `index.html`/`futures.html` — file `config.js` tidak ada di repo,
        404 setiap load (tidak berbahaya, tapi mubazir).
  - [ ] `apps/frontend/src/_encoding_test.js` — file debug 2 baris, tidak
        direferensikan HTML manapun. Hapus.
  - [ ] `scripts/fetch-sentiment.py`, `scripts/smoke.js`,
        `scripts/noctua_perp_adjust.py` — tidak dipanggil workflow manapun.
        Peninggalan arsitektur lama.
  - [ ] `tryLoadSnapshot()` di `data.js` — fallback ke `./data/*.json`
        kemungkinan besar unreachable di production sekarang.
  - [ ] Root `package.json` deklarasi `turbo` sebagai devDependency + README
        bilang "dikelola dengan Turborepo", tapi tidak ada `turbo.json` dan
        script cuma manggil `pnpm --filter` langsung. Turbo tidak
        benar-benar dipakai — hapus dependency-nya atau benar-benar wire up.

- [ ] **README masih menyuruh setup Cloudflare Pages terpisah**
      Section "Setup Awal" langkah 4–5 (buat project Pages terpisah +
      set `_redirects`) sudah usang — `wrangler.toml [assets]` sudah serve
      frontend langsung dari Worker yang sama (single-origin). Kontributor
      baru yang ikuti README literal akan setup deployment kedua yang
      tidak berguna.
      **Fix:** hapus/update langkah 4–5.

- [ ] **Binding D1 `BITBOT_DB` tidak dipakai**
      `wrangler.toml` masih deklarasi `[[d1_databases]] binding = "BITBOT_DB"`,
      tapi tidak ada referensi `Env.BITBOT_DB` di `apps/worker/src/**`.
      Kelihatan sisa boilerplate dari project lain. **Fix:** hapus binding
      kalau memang tidak dipakai.

- [ ] **Deploy production tanpa gate**
      `.github/workflows/deploy-worker.yml` langsung deploy ke production
      di setiap push ke `main` — tidak ada step lint/typecheck/test.
      **Fix:** tambahkan minimal typecheck (`tsc --noEmit`) sebelum deploy.

- [ ] **Dependency model Python tidak di-pin**
      `model/serve/requirements-ci.txt` / `requirements.txt` pakai `>=`
      untuk numpy/scipy/pandas/pyarrow. Cron jalan tiap 30 menit — rilis
      upstream yang mengubah perilaku bisa diam-diam mengubah forecast atau
      bikin job gagal.
      **Fix:** pin versi exact, atau tambahkan lockfile (`pip-compile`, dll).

---

## 🟢 Low priority / cleanup

- [ ] `apps/worker/src/routes/noctua.ts` — perbandingan secret pakai `!==`
      (bukan constant-time compare). Risiko rendah di Workers, tapi mudah
      diganti.
- [ ] `apps/worker/src/routes/enrichment.ts` — `GET /news` dan `GET /fg`
      memanggil `JSON.parse(raw)` tanpa try/catch; KV entry korup akan
      bikin 500, bukan degrade gracefully seperti bagian app lain.
- [ ] Konfirmasi apakah `model/serve/noctua_weights.npz` (v1) masih perlu
      disimpan sebagai fallback, atau sudah jadi artifact basi sejak v2 ada.
- [ ] Cek anggaran menit GitHub Actions jangka panjang — cron 30 menit
      dengan timeout 20 menit lumayan besar untuk repo private.

---

## ✅ Sudah diperbaiki (tidak perlu dikerjakan lagi)

- [x] ~~CORS pakai substring match, bukan hostname check~~
      → diperbaiki di commit `cef013a`. `apps/worker/src/index.ts` sekarang
      pakai `isAllowedOrigin()` yang parse `new URL(origin).hostname` dan
      cek `hostname.endsWith('.pages.dev')` (bukan `origin.includes(...)`),
      jadi `btc-dashboard.evil.com` atau `evil-pages.dev.attacker.com` tidak
      lolos lagi.
- [x] ~~`/api/noctua/push` tidak validasi schema + field lolos ke `innerHTML` tanpa escape~~
      → diperbaiki di commit `cef013a` (server) dan `fbab784` (frontend).
      `apps/worker/src/routes/noctua.ts` sekarang punya `sanitizePayload()`
      dengan allow-list field (STRING_FIELDS/NUMBER_FIELDS/BOOL_FIELDS/
      JSON_FIELDS) — tidak ada lagi `...b` mentah masuk KV. Di
      `apps/frontend/src/ui.js::updateBGTCCard()`, `BGTC.sourceTs`,
      `BGTC.freshness`, dan `BGTC.proxy` sekarang di-escape lewat `escape()`
      sebelum masuk `innerHTML`.
- [x] ~~Link berita tidak validasi skema URL~~
      → diperbaiki di commit `fbab784`. `apps/frontend/src/ui.js::updateNewsFeed()`
      sekarang cek `isSafeUrl = /^https?:\/\//i.test(item.url)` sebelum
      render sebagai `<a href>`; kalau bukan http/https, item dirender
      sebagai teks biasa (bukan link yang bisa diklik).
- [x] ~~Bundle history NOCTUA tidak pernah di-commit balik setelah bootstrap~~
      → diperbaiki di commit `244f807` (step "Commit bundle history jika
      berubah" ditambahkan ke `noctua-predict.yml`).
- [x] ~~Staging/production/local dev berbagi KV & D1 yang sama~~
      → diperbaiki di commit `3ca4233` (environment `staging`/`production`
      dihapus, jadi satu environment eksplisit, didokumentasikan di
      `wrangler.toml` dan README).
