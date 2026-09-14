# Checklist Upgrade UI &middot; BTC Desk &rarr; Pro Premium

Berdasarkan analisis langsung terhadap `bygatc-main.zip` (index.html, futures.html, options.html, src/ui.js, src/charts.js).

## Fase 1 — Fondasi (konsolidasi, wajib duluan)
- [x] Ekstrak `:root{...}` variables (warna, font, spacing) dari index.html ke `apps/frontend/styles/base.css`
- [x] Pindahkan komponen bersama (`.btn`, `.pill-sm`, `.pill-sm`, card base, modal) ke `base.css`
- [x] Import `base.css` di index.html, futures.html, dan options.html — hapus duplikasi `<style>` yang saat ini terpisah (287 / 120 / ~100 baris sendiri-sendiri)
- [x] Audit selisih warna/spacing antar 3 file setelah konsolidasi, samakan yang beda tanpa sengaja

> **Catatan audit (selesai):** index.html sudah lebih dulu memakai `base.css` (token kanonik: `--bg #0a0a0f`, `--dim #52525b`, dll). futures.html & options.html sebelumnya punya `:root` terpisah dengan nama variabel berbeda (`--panel/--txt/--grn/--amb/--acc/--line/--mono`) dan nilai warna sedikit berbeda (mis. `--bg #0b0e14` vs `#0a0a0f`, `--dim #7e8aa3` vs `#52525b`, `--red #ff5470` vs `#f87171`). `base.css` sudah menyediakan alias (`--panel→--surface`, dst) sehingga kedua file itu tidak perlu ditulis ulang nama variabelnya — sekarang keduanya sudah di-`<link>` ke `base.css`, `:root`/reset/`.card` duplikat sudah dihapus, dan seluruh 3 halaman memakai satu sumber warna. CSP `style-src`/`font-src` di futures.html & options.html diperluas ke `fonts.googleapis.com`/`fonts.gstatic.com` supaya `@import` font di base.css tidak diblokir. Efek samping yang disengaja: warna latar & teks redup di futures/options kini sedikit lebih gelap (mengikuti token kanonik index.html), dan padding `.card` futures/options ikut ke `14px 16px` (dari `14px` rata).

## Fase 2 — Samakan level polish 3 halaman
- [ ] futures.html: tambahkan `box-shadow` pada card (saat ini 0 dipakai vs index.html)
- [ ] futures.html & options.html: tambahkan `transition` di semua elemen interaktif (tombol, slider, toggle Long/Short)
- [ ] options.html: tambahkan minimal 1 `@keyframes` untuk update angka live (saat ini 0)
- [ ] Samakan padding & radius card di ketiga halaman (grid rhythm konsisten)

## Fase 3 — Depth & premium feel
- [ ] Tambahkan ambient glow (radial-gradient blur, low opacity) di belakang angka hero (harga BTC, verdict utama)
- [ ] Tambahkan border gradient tipis pada card keputusan (verdict/NO-TRADE/LONG)
- [ ] Ganti flat `surface/surface2/surface3` jadi elevasi bertingkat dengan shadow lembut, bukan cuma beda warna
- [ ] Refine focus state input & slider (ring lembut, bukan outline default browser)

## Fase 4 — Ikon & micro-interaction
- [ ] Ganti semua ikon emoji (🔴🟢🟡 dst di catatan & jam trading) dengan SVG icon set konsisten (mis. Lucide), pakai `currentColor`
- [ ] Tambahkan animasi count-up untuk angka penting (harga, IV, funding, DVOL)
- [ ] Ganti placeholder `&mdash;` saat loading dengan skeleton shimmer
- [ ] Tambahkan state hover/press yang jelas di semua tombol & toggle

## Fase 5 — Data visualization
- [ ] Gauge/probability bar (kurva barrier, prob sentuh) pakai SVG animated (`stroke-dashoffset` transition), bukan bar statis
- [ ] Chart candle/vol seasonality: tambahkan smooth transition saat data refresh, bukan render ulang mendadak
- [ ] Tambahkan tooltip on-hover untuk titik data di chart (saat ini kemungkinan belum ada)

## Fase 6 — Branding & sentuhan akhir
- [ ] Ganti favicon dari emoji ₿ ke logo mark custom (SVG)
- [ ] Tambahkan gradient tipis di tombol CTA utama (Segarkan, Long/Short, submit)
- [ ] Cek tap target size & padding header di breakpoint mobile (375–414px) — sesuai screenshot, ini dilihat langsung dari browser HP
- [ ] Review konsistensi letter-spacing & font-weight scale lintas 3 halaman

## Urutan pengerjaan yang disarankan
1. Fase 1 (fondasi) — tanpa ini, semua perubahan visual berikutnya akan double-maintenance
2. Fase 2 (samakan polish) — dampak paling terlihat untuk usaha paling kecil
3. Fase 3 & 4 (depth + ikon) — ini yang paling mengubah kesan "hobby" jadi "produk"
4. Fase 5 (data viz) — butuh waktu lebih karena menyentuh charts.js
5. Fase 6 (branding) — polish terakhir sebelum rilis
