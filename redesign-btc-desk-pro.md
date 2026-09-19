# Redesign BTC Desk &rarr; Pro Premium
*Audit + langkah eksekusi. Semua temuan diambil literal dari grep/diff ke `bygatc-main.zip` &mdash; bukan template generik.*

---

## Bagian 1 &middot; Audit (Temuan)

### Temuan 1 — `.btn` cuma ada di 1 dari 3 halaman
```
grep ".btn{" index.html futures.html options.html
→ hanya muncul di index.html (baris 55)
```
Tombol di `futures.html` (`#btnLong`/`#btnShort`, class `.long active` / `.short`) dan `options.html` pakai sistem penamaan sendiri, bukan komponen bersama. Ini yang bikin tombol "Long/Short" di screenshot Futures terasa beda kelas sama tombol di halaman Opsi.

### Temuan 2 — box-shadow cuma dipakai 1 kali di SELURUH codebase
```
grep -o "box-shadow:[^;]*;" index.html futures.html options.html
→ 1 hasil: box-shadow:0 0 8px rgba(255,255,255,.4)  (bukan di card, di elemen kecil)
```
Bukan cuma futures/options yang flat — index.html yang "paling polished" pun sebenarnya nggak punya elevasi/depth. Semua kedalaman visual di screenshot murni dari beda warna background (surface/surface2/surface3), bukan shadow.

### Temuan 3 — Spacing tidak punya skala, murni angka acak
```
grep -o "padding:[0-9]*px[^;]*" index.html | sort -u
→ 10px 12px, 10px 14px, 11px 13px, 11px 14px, 12px 14px, 12px 18px, 14px 16px,
  14px 18px, 16px, 16px 18px, 18px 16px, 18px 20px ...
```
Border-radius juga sama: 2px, 3px, 4px, 6px, 7px, 8px, 9px, 10px, 12px — sembilan nilai berbeda tersebar tanpa pola. Ini yang bikin mata bawah sadar merasa "kurang rapi" walau tiap elemen individual sudah oke.

### Temuan 4 — Logika gauge/bar ditulis dua kali secara terpisah
```
comm antara function di options.js dan futures.js
→ cuma "renderAll" yang namanya sama. Sisanya: renderBarrierCurves/renderSafeLevels
  (futures.js) vs renderStrangle/renderChain (options.js) — dua implementasi
  probability-bar yang independen
```
Kalau kamu ubah tampilan satu gauge, harus diubah manual di 2 tempat dengan risiko hasilnya beda lagi.

### Temuan 5 — 71 elemen pakai `style="..."` inline
```
grep -c 'style="' index.html futures.html options.html
→ 33 + 15 + 23 = 71 inline style di seluruh frontend
```
Indikator paling jelas "belum ada design system" — tiap elemen di-style satu-satu langsung di HTML.

### Temuan 6 — emoji cuma di 1 file, bukan tersebar
```
python3 regex unicode-emoji ke semua src/*.js dan data/*.json
→ 7 emoji (🟢🔴📌🟡), SEMUA persis di src/options.js — 0 di index.html/futures.js
```
Emoji render beda-beda tergantung OS/browser — bukan cuma soal kesan "hobi", tapi juga inkonsistensi visual lintas device. Karena lokasinya presisi di 1 file, fix-nya juga lokal.

---

## Bagian 2 &middot; Langkah Eksekusi

**Aturan main sebelum mulai:** jangan pernah ubah `id="..."` di HTML (mis. `#rangerRaw`, `#btnLong`, `#panduanModal`) &mdash; itu di-bind langsung oleh JS. Yang boleh diubah bebas: `class`, `style`, dan struktur CSS.

### Langkah 1 — Buat `styles/tokens.css`
Pindahkan palette warna dari index.html apa adanya, tambah token spacing/radius/shadow yang sekarang belum standar:
```css
:root{
  --bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a24;--surface3:#22222e;
  --border:rgba(255,255,255,0.06);--border2:rgba(255,255,255,0.11);
  --text:#e7e7f0;--muted:#71717a;--dim:#52525b;
  --accent:#818cf8;--accent2:#a78bfa;
  --green:#4ade80;--green-bg:rgba(74,222,128,0.1);--green-bd:rgba(74,222,128,0.3);
  --red:#f87171;--red-bg:rgba(248,113,113,0.1);--red-bd:rgba(248,113,113,0.3);
  --amber:#fbbf24;--amber-bg:rgba(251,191,36,0.1);--amber-bd:rgba(251,191,36,0.3);
  --blue:#60a5fa;--cyan:#22d3ee;--pink:#f472b6;
  --font-mono:'Space Mono',monospace;--font:'Inter',system-ui,sans-serif;

  --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:24px;--sp-6:32px;
  --r-sm:4px;--r-md:8px;--r-lg:12px;
  --shadow-sm:0 1px 2px rgba(0,0,0,.3);
  --shadow-md:0 4px 16px rgba(0,0,0,.35);
  --shadow-glow:0 0 24px rgba(129,140,248,.15);
}
```

### Langkah 2 — Buat `styles/components.css`
Generalisasi `.btn` dari index.html (baris 55) jadi family yang bisa dipakai semua tombol termasuk Long/Short di futures.html:
```css
.btn{background:transparent;border:1px solid var(--border2);color:var(--text);
  font-family:var(--font-mono);font-size:10px;padding:var(--sp-2) var(--sp-3);
  border-radius:var(--r-md);cursor:pointer;transition:all .15s;letter-spacing:.04em}
.btn:hover{background:var(--surface2);border-color:var(--accent);color:var(--accent)}
.btn-toggle.active.long{background:var(--green-bg);border-color:var(--green-bd);color:var(--green)}
.btn-toggle.active.short{background:var(--red-bg);border-color:var(--red-bd);color:var(--red)}
```
Pindahkan juga `.pill-sm` dan card base ke sini.

### Langkah 3 — Link kedua file di ketiga halaman
```html
<link rel="stylesheet" href="styles/tokens.css">
<link rel="stylesheet" href="styles/components.css">
```
**Verifikasi:** buka index.html, futures.html, options.html — pastikan tidak ada style yang keimpor dobel/konflik.

### Langkah 4 — Satukan tombol Long/Short
```html
<button id="btnLong" class="btn btn-toggle active long" type="button">LONG</button>
<button id="btnShort" class="btn btn-toggle short" type="button">SHORT</button>
```
JS yang toggle class `active`/`long`/`short` tidak perlu diubah — cuma nambah kelas dasar `.btn`.

### Langkah 5 — Normalisasi spacing & radius
File per file (index &rarr; futures &rarr; options): ganti semua `padding:`/`border-radius:` literal ke `var(--sp-*)`/`var(--r-*)` terdekat. Kerjakan satu file penuh baru pindah, biar gampang di-review.

### Langkah 6 — Satukan logic probability bar
Karena futures.html & options.html **tidak** me-load `ui.js`/`charts.js` (cuma index.html yang load):
- Buat file baru `src/shared-ui.js` isi `function renderProbabilityBar(el, data, opts){...}`
- Tambahkan `<script src="src/shared-ui.js"></script>` di ketiga html, sebelum script halamannya masing-masing
- Ganti isi `renderBarrierCurves`/`renderStrangle` dkk supaya manggil fungsi bersama ini

### Langkah 7 — Ganti emoji jadi ikon
Cari 7 kemunculan emoji di `src/options.js`, ganti dengan `<span class="dot dot-green/red/amber">` (pattern `.dot` sudah ada di index.html, baris ~512) atau SVG inline.

### Langkah 8 — Pasang shadow di titik fokus utama
Prioritas: `.hero` (verdict card, index.html), card "NO-TRADE"/keputusan di futures.html, verdict card di options.html.
```css
.hero{ box-shadow: var(--shadow-md); }
.hero.go{ box-shadow: var(--shadow-md), var(--shadow-glow); }
```

### Langkah 9 — Beresin inline style
71 total (33 index / 15 futures / 23 options). Prioritaskan yang berulang &gt;2&times; &rarr; jadikan utility class. Sisakan inline cuma untuk nilai dinamis dari JS.

### Langkah 10 — Baru eksplorasi visual baru
Gradient di CTA, count-up animation, dsb &mdash; **terakhir**, setelah token & class rapi. Kalau dibalik, kerjaan visual baru bakal ke-normalize ulang di Langkah 5.

### Cara verifikasi tiap langkah
Buka index.html, futures.html, options.html di browser HP setelah tiap langkah — pastikan angka live masih update, tombol Long/Short masih toggle, modal Panduan masih buka/tutup normal.