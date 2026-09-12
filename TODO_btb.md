# TODO â `harvey-moeid/btb`

Disusun dari `REVIEW_btb.md` (commit `d370f1b`) + verifikasi ulang terhadap
HEAD saat ini. Yang sudah selesai dicoret dan diberi catatan; sisanya masih
perlu dikerjakan.

> **Update:** ketiga item High priority sudah diperbaiki di commit `cef013a`
> dan `fbab784` (setelah HEAD `c415a13` yang jadi acuan awal TODO ini).
> Dipindah ke bagian "Sudah diperbaiki" di bawah, per verifikasi ulang kode.

---

## ð¡ Medium priority

- [ ] **Mojibake masih tersebar luas â lebih parah dari yang tercatat sebelumnya**
      Verifikasi ulang (2026-09-12) terhadap seluruh file frontend: masih
      rusak di `apps/frontend/src/data.js`, `apps/frontend/src/options.js`,
      dan `README.md` (termasuk judul & diagram ASCII-nya sendiri, meski
      sudah ada beberapa commit "fix mojibake" khusus README) â **dan
      `apps/frontend/src/ui.js`, yang belum pernah tercatat di TODO ini
      sebelumnya** tapi rusaknya cukup parah (pola campuran: em dash, titik
      tengah `Â·`, simbol panah naik/turun, tanda section `Â§`). File lain
      sudah dikonfirmasi bersih dan TIDAK perlu disentuh lagi: `main.js`,
      `charts.js`, `futures.js`, `rateLimit.js`, ketiga file `.html`
      (`index.html`/`options.html`/`futures.html`), `docs/TRADE_FLOW.md`,
      dan semua `apps/worker/src/**`.

      **Fix â dibagi 4 sesi per FILE (bukan per jumlah baris), urut dari
      risiko terendah ke tertinggi:**
      - [ ] Sesi 1: `README.md` â 1 pola rusak (`Ã¢` â em dash), tanpa
            risiko fungsional. Dipakai untuk validasi metode sebelum lanjut
            ke file yang lebih besar.
      - [ ] Sesi 2: `data.js` â pola sama dengan Sesi 1, ~50 kemunculan,
            semuanya di string pesan keputusan trading (`buildDecision`,
            `buildRetailPlan`, dll). Review manual wajib karena teks ini
            tampil langsung ke user sebagai alasan trade.
      - [ ] Sesi 3: `ui.js` â pola campuran (lihat di atas). **Jangan**
            sentuh logika `escape()` (proteksi XSS yang sudah ada di file
            ini) â hanya perbaiki isi string literal-nya.
      - [ ] Sesi 4: `options.js` â file terbesar (~600 baris) & paling
            kompleks: `Â±` (Â±), `Ã` (Ã), `Î` (Î delta), `Ï` (Ï sigma), plus
            beberapa emoji yang pecah jadi byte aneh. Kerjakan terakhir,
            setelah metode teruji di 3 sesi sebelumnya.

      Metode per sesi: script deteksi/decode double-encoding (byte UTF-8
      yang terlanjur dibaca sebagai Latin-1/cp1252), lalu review diff manual
      sebelum push â bukan regex tebak-tebakan global satu kali jalan.
      Tiap sesi = satu PR terpisah, supaya gampang di-revert individual
      kalau ada karakter yang salah tebak.

      Setelah 4 sesi selesai: sweep tambahan opsional untuk `model/`
      (Python), `scripts/`, dan `data/*.json` supaya repo benar-benar bersih
      sesuai tujuan awal ("satu pass bersih UTF-8 di seluruh repo") â belum
      diverifikasi, tapi kemungkinan besar sudah bersih karena area ini
      tidak pernah tercatat kena masalah encoding di riwayat commit manapun.

- [ ] **`options.html` (desk opsi) pakai arsitektur fetch berbeda dari desk lain**
      `apps/frontend/src/options.js` fetch langsung ke `deribit.com`,
      `api.binance.com`, `fapi.binance.com` dari browser â tanpa failover,
      tanpa cache bersama (beda dengan `index.html`/`futures.html` yang
      lewat Worker `market.ts`, yang sudah punya failover + KV cache).
      **Fix:** unifikasi lewat Worker, atau minimal dokumentasikan
      perbedaan arsitektur ini secara eksplisit.

- [ ] **Kode/aset mati**
  - [ ] `apps/frontend/src/rateLimit.js` â `beginCall`/`canCall`/`record`
        tidak pernah dipanggil (`main.js` cuma pakai `getStats()`), jadi
        panel "Anggaran API" akan selalu tampil 0 pemakaian â menyesatkan.
  - [ ] `<script src="src/config.js" onerror="this.remove()">` di
        `index.html`/`futures.html` â file `config.js` tidak ada di repo,
        404 setiap load (tidak berbahaya, tapi mubazir).
  - [ ] `apps/frontend/src/_encoding_test.js` â file debug 2 baris, tidak
        direferensikan HTML manapun. Hapus.
  - [ ] `scripts/fetch-sentiment.py`, `scripts/smoke.js`,
        `scripts/noctua_perp_adjust.py` â tidak dipanggil workflow manapun.
        Peninggalan arsitektur lama.
  - [ ] `tryLoadSnapshot()` di `data.js` â fallback ke `./data/*.json`
        kemungkinan besar unreachable di production sekarang.
  - [ ] Root `package.json` deklarasi `turbo` sebagai devDependency + README
        bilang "dikelola dengan Turborepo", tapi tidak ada `turbo.json` dan
        script cuma manggil `pnpm --filter` langsung. Turbo tidak
        benar-benar dipakai â hapus dependency-nya atau benar-benar wire up.

- [ ] **README masih menyuruh setup Cloudflare Pages terpisah**
      Section "Setup Awal" langkah 4â5 (buat project Pages terpisah +
      set `_redirects`) sudah usang â `wrangler.toml [assets]` sudah serve
      frontend langsung dari Worker yang sama (single-origin). Kontributor
      baru yang ikuti README literal akan setup deployment kedua yang
      tidak berguna.
      **Fix:** hapus/update langkah 4â5.

- [ ] **Binding D1 `BITBOT_DB` tidak dipakai**
      `wrangler.toml` masih deklarasi `[[d1_databases]] binding = "BITBOT_DB"`,
      tapi tidak ada referensi `Env.BITBOT_DB` di `apps/worker/src/**`.
      Kelihatan sisa boilerplate dari project lain.
      **Status:** fix sudah dibuat, menunggu review/merge di PR #6
      (`fix/remove-unused-d1-binding-and-add-typecheck-gate`).

- [ ] **Deploy production tanpa gate**
      `.github/workflows/deploy-worker.yml` langsung deploy ke production
      di setiap push ke `main` â tidak ada step lint/typecheck/test.
      **Status:** fix sudah dibuat (typecheck gate sebelum deploy),
      menunggu review/merge di PR #6
      (`fix/remove-unused-d1-binding-and-add-typecheck-gate`).

- [ ] **Dependency model Python tidak di-pin**
      `model/serve/requirements-ci.txt` / `requirements.txt` pakai `>=`
      untuk numpy/scipy/pandas/pyarrow. Cron jalan tiap 30 menit â rilis
      upstream yang mengubah perilaku bisa diam-diam mengubah forecast atau
      bikin job gagal.
      **Fix:** pin versi exact, atau tambahkan lockfile (`pip-compile`, dll).

---

## ð¢ Low priority / cleanup

- [ ] `apps/worker/src/routes/noctua.ts` â perbandingan secret pakai `!==`
      (bukan constant-time compare). Risiko rendah di Workers, tapi mudah
      diganti.
- [ ] `apps/worker/src/routes/enrichment.ts` â `GET /news` dan `GET /fg`
      memanggil `JSON.parse(raw)` tanpa try/catch; KV entry korup akan
      bikin 500, bukan degrade gracefully seperti bagian app lain.
- [ ] Konfirmasi apakah `model/serve/noctua_weights.npz` (v1) masih perlu
      disimpan sebagai fallback, atau sudah jadi artifact basi sejak v2 ada.
- [ ] Cek anggaran menit GitHub Actions jangka panjang â cron 30 menit
      dengan timeout 20 menit lumayan besar untuk repo private.

---

## â Sudah diperbaiki (tidak perlu dikerjakan lagi)

- [x] ~~CORS pakai substring match, bukan hostname check~~
      â diperbaiki di commit `cef013a`. `apps/worker/src/index.ts` sekarang
      pakai `isAllowedOrigin()` yang parse `new URL(origin).hostname` dan
      cek `hostname.endsWith('.pages.dev')` (bukan `origin.includes(...)`),
      jadi `btc-dashboard.evil.com` atau `evil-pages.dev.attacker.com` tidak
      lolos lagi.
- [x] ~~`/api/noctua/push` tidak validasi schema + field lolos ke `innerHTML` tanpa escape~~
      â diperbaiki di commit `cef013a` (server) dan `fbab784` (frontend).
      `apps/worker/src/routes/noctua.ts` sekarang punya `sanitizePayload()`
      dengan allow-list field (STRING_FIELDS/NUMBER_FIELDS/BOOL_FIELDS/
      JSON_FIELDS) â tidak ada lagi `...b` mentah masuk KV. Di
      `apps/frontend/src/ui.js::updateBGTCCard()`, `BGTC.sourceTs`,
      `BGTC.freshness`, dan `BGTC.proxy` sekarang di-escape lewat `escape()`
      sebelum masuk `innerHTML`.
- [x] ~~Link berita tidak validasi skema URL~~
      â diperbaiki di commit `fbab784`. `apps/frontend/src/ui.js::updateNewsFeed()`
      sekarang cek `isSafeUrl = /^https?:\/\//i.test(item.url)` sebelum
      render sebagai `<a href>`; kalau bukan http/https, item dirender
      sebagai teks biasa (bukan link yang bisa diklik).
- [x] ~~Bundle history NOCTUA tidak pernah di-commit balik setelah bootstrap~~
      â diperbaiki di commit `244f807` (step "Commit bundle history jika
      berubah" ditambahkan ke `noctua-predict.yml`).
- [x] ~~Staging/production/local dev berbagi KV & D1 yang sama~~
      â diperbaiki di commit `3ca4233` (environment `staging`/`production`
      dihapus, jadi satu environment eksplisit, didokumentasikan di
      `wrangler.toml` dan README).
