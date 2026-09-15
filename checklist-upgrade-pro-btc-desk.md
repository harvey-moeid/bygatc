# Checklist Upgrade UI &middot; BTC Desk &rarr; Pro Premium

Berdasarkan analisis langsung terhadap `bygatc-main.zip` (index.html, futures.html, options.html, src/ui.js, src/charts.js).

## Fase 1 â Fondasi (konsolidasi, wajib duluan)
- [x] Ekstrak `:root{...}` variables (warna, font, spacing) dari index.html ke `apps/frontend/styles/base.css`
- [x] Pindahkan komponen bersama (`.btn`, `.pill-sm`, `.pill-sm`, card base, modal) ke `base.css`
- [x] Import `base.css` di index.html, futures.html, dan options.html â hapus duplikasi `<style>` yang saat ini terpisah (287 / 120 / ~100 baris sendiri-sendiri)
- [x] Audit selisih warna/spacing antar 3 file setelah konsolidasi, samakan yang beda tanpa sengaja

> **Catatan audit (selesai):** index.html sudah lebih dulu memakai `base.css` (token kanonik: `--bg #0a0a0f`, `--dim #52525b`, dll). futures.html & options.html sebelumnya punya `:root` terpisah dengan nama variabel berbeda (`--panel/--txt/--grn/--amb/--acc/--line/--mono`) dan nilai warna sedikit berbeda (mis. `--bg #0b0e14` vs `#0a0a0f`, `--dim #7e8aa3` vs `#52525b`, `--red #ff5470` vs `#f87171`). `base.css` sudah menyediakan alias (`--panelâ--surface`, dst) sehingga kedua file itu tidak perlu ditulis ulang nama variabelnya â sekarang keduanya sudah di-`<link>` ke `base.css`, `:root`/reset/`.card` duplikat sudah dihapus, dan seluruh 3 halaman memakai satu sumber warna. CSP `style-src`/`font-src` di futures.html & options.html diperluas ke `fonts.googleapis.com`/`fonts.gstatic.com` supaya `@import` font di base.css tidak diblokir. Efek samping yang disengaja: warna latar & teks redup di futures/options kini sedikit lebih gelap (mengikuti token kanonik index.html), dan padding `.card` futures/options ikut ke `14px 16px` (dari `14px` rata).

## Fase 2 â Samakan level polish 3 halaman
- [x] futures.html: tambahkan `box-shadow` pada card (saat ini 0 dipakai vs index.html)
- [x] futures.html & options.html: tambahkan `transition` di semua elemen interaktif (tombol, slider, toggle Long/Short)
- [x] options.html: tambahkan minimal 1 `@keyframes` untuk update angka live (saat ini 0)
- [x] Samakan padding & radius card di ketiga halaman (grid rhythm konsisten)

> **Catatan audit (selesai):** `box-shadow:0 2px 6px rgba(0,0,0,.3)` ditambahkan ke `.card` di `base.css` sehingga otomatis berlaku ke ketiga halaman (index/futures/options), karena semua sudah share komponen `.card` dari Fase 1. futures.html: `.dir-toggle button`, `input[type=number]`, dan `button` sudah punya `transition` (background/border-color/color .15s). options.html: `select,button` sudah punya `transition` yang sama, plus `@keyframes flashUpdate` (dipakai lewat class `.flash-update` di `flash()` pada options.js, dipicu setelah fetch data live berhasil, bukan saat slider strangle digeser). Padding (`14px 16px`) & radius (`10px`) card sudah seragam di ketiga halaman karena satu sumber `.card` dari `base.css` -- tidak ada override lokal di futures.html/options.html/index.html.

## Fase 3 â Depth & premium feel
- [ ] Tambahkan ambient glow (radial-gradient blur, low opacity) di belakang angka hero (harga BTC, verdict utama)
- [ ] Tambahkan border gradient tipis pada card keputusan (verdict/NO-TRADE/LONG)
- [ ] Ganti flat `surface/surface2/surface3` jadi elevasi bertingkat dengan shadow lembut, bukan cuma beda warna
- [ ] Refine focus state input & slider (ring lembut, bukan outline default browser)

## Fase 4 â Ikon & micro-interaction
- [ ] Ganti semua ikon emoji (ð´ð¢ð¡ dst di catatan & jam trading) dengan SVG icon set konsisten (mis. Lucide), pakai `currentColor`
- [ ] Tambahkan animasi count-up untuk angka penting (harga, IV, funding, DVOL)
- [ ] Ganti placeholder `&mdash;` saat loading dengan skeleton shimmer
- [ ] Tambahkan state hover/press yang jelas di semua tombol & toggle

## Fase 5 â Data visualization
- [ ] Gauge/probability bar (kurva barrier, prob sentuh) pakai SVG animated (`stroke-dashoffset` transition), bukan bar statis
- [ ] Chart candle/vol seasonality: tambahkan smooth transition saat data refresh, bukan render ulang mendadak
- [ ] Tambahkan tooltip on-hover untuk titik data di chart (saat ini kemungkinan belum ada)

## Fase 6 â Branding & sentuhan akhir
- [ ] Ganti favicon dari emoji â¿ ke logo mark custom (SVG)
- [ ] Tambahkan gradient tipis di tombol CTA utama (Segarkan, Long/Short, submit)
- [ ] Cek tap target size & padding header di breakpoint mobile (375â414px) â sesuai screenshot, ini dilihat langsung dari browser HP
- [ ] Review konsistensi letter-spacing & font-weight scale lintas 3 halaman

## Urutan pengerjaan yang disarankan
1. Fase 1 (fondasi) â tanpa ini, semua perubahan visual berikutnya akan double-maintenance
2. Fase 2 (samakan polish) â dampak paling terlihat untuk usaha paling kecil
3. Fase 3 & 4 (depth + ikon) â ini yang paling mengubah kesan "hobby" jadi "produk"
4. Fase 5 (data viz) â butuh waktu lebih karena menyentuh charts.js
5. Fase 6 (branding) â polish terakhir sebelum rilis
