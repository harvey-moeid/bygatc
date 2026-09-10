/* =========================================================================
   BTC Option-Selling Desk â src/options.js (v1)
   One Deribit call for the full chain; IV inverted locally via Black-76
   bisection; analytic deltas; delta-targeted short-strangle builder with a
   Delta-Exchange margin heuristic; regime gate from BGTC + F&G + funding.
   Free resources only. No keys. CORS-clean endpoints:
     - api.deribit.com (Access-Control-Allow-Origin: *)
     - api.binance.com / fapi.binance.com
     - local ./data/*.json snapshots (committed by GH Actions)
   ========================================================================= */
'use strict';

/* ------------------------------ math: Black-76 -------------------------- */
function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 â |err| < 7.5e-8, plenty for IV work
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
          t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function black76(F, K, T, sigma, isCall) {
  if (T <= 0 || sigma <= 0) return Math.max(isCall ? F - K : K - F, 0);
  const sT = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sT * sT) / sT;
  const d2 = d1 - sT;
  return isCall ? F * normCdf(d1) - K * normCdf(d2)
                : K * normCdf(-d2) - F * normCdf(-d1);
}

function black76Delta(F, K, T, sigma, isCall) {
  if (T <= 0 || sigma <= 0) return isCall ? (F > K ? 1 : 0) : (F < K ? -1 : 0);
  const sT = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sT * sT) / sT;
  return isCall ? normCdf(d1) : normCdf(d1) - 1;
}

function impliedVol(price, F, K, T, isCall) {
  // bisection: robust, monotone in sigma; 60 iters â 1e-9 precision
  if (!(price > 0) || !(F > 0) || !(K > 0) || !(T > 0)) return null;
  const intrinsic = Math.max(isCall ? F - K : K - F, 0);
  if (price <= intrinsic + 1e-9) return null;          // at/below intrinsic
  let lo = 0.005, hi = 5.0;
  if (black76(F, K, T, hi, isCall) < price) return null; // absurd mark
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    (black76(F, K, T, mid, isCall) > price) ? hi = mid : lo = mid;
  }
  return (lo + hi) / 2;
}

/* ------------------------------ state ----------------------------------- */
const S = {
  spot: null, hv20: null, funding: null,
  dvol: null, dvolPrev: null, shock: null,   // input Radar Pembeli
  kronos: null, fng: null,
  chainByExpiry: new Map(),   // expiryMs -> [{strike, callMark, putMark, callOi, putOi, iv..., delta...}]
  selectedExpiry: null,
};

const $ = id => document.getElementById(id);
const fmt$ = v => v == null ? 'â' : '$' + Math.round(v).toLocaleString();
const fmtPct = (v, d = 1) => v == null ? 'â' : (v * 100).toFixed(d) + '%';

/* ------------------------------ fetchers --------------------------------- */
async function jget(url, opts) {
  const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts));
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}

async function fetchChain() {
  // Single call: every BTC option's mark, OI, underlying â we solve IV ourselves.
  const j = await jget('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
  const rows = j.result || [];
  const byExp = new Map();
  let spot = null;
  for (const r of rows) {
    // instrument_name: BTC-27JUN26-60000-C
    const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(r.instrument_name);
    if (!m) continue;
    const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    const expMs = Date.UTC(2000 + +m[3], months[m[2]], +m[1], 8, 0, 0); // expiry Deribit 08:00 UTC
    if (expMs < Date.now() + 30 * 60_000) continue;                      // lewati yang expire <30m
    const strike = +m[4];
    if (r.underlying_price > 0) spot = r.underlying_price;
    if (!byExp.has(expMs)) byExp.set(expMs, new Map());
    const chain = byExp.get(expMs);
    if (!chain.has(strike)) chain.set(strike, { strike });
    const row = chain.get(strike);
    const markUsd = (r.mark_price || 0) * (r.underlying_price || 0);     // mark dalam BTC -> USD
    if (m[5] === 'C') { row.callMark = markUsd; row.callOi = r.open_interest || 0; }
    else              { row.putMark  = markUsd; row.putOi  = r.open_interest || 0; }
  }
  S.spot = spot;
  S.chainByExpiry = new Map(
    [...byExp.entries()].sort((a, b) => a[0] - b[0])
      .map(([exp, m]) => [exp, [...m.values()].sort((a, b) => a.strike - b.strike)])
  );
}

async function fetchHv20() {
  // 121 candle harian: cukup untuk HV20, MA100, drawdown 90h dan RSI(14) dalam satu panggilan.
  const k = await jget('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=121');
  const allCloses = k.map(c => +c[4]);
  const closes = allCloses.slice(-22);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  S.hv20 = Math.sqrt(varr) * Math.sqrt(365);

  // Pendeteksi hari shock (Radar Pembeli): |pergerakan harian terakhir| > 2.5x vol harian trailing.
  // Backtest pasca-ETF: straddle 5h menang 43.2% vs baseline 35.0% dengan biaya DVOL riil (p=0.044, n=37).
  const prior = rets.slice(0, -1);                       // kecualikan return paling baru
  const pm = prior.reduce((a, b) => a + b, 0) / prior.length;
  const pv = prior.reduce((a, b) => a + (b - pm) ** 2, 0) / (prior.length - 1);
  const dailySd = Math.sqrt(pv);
  const lastRet = rets[rets.length - 1];
  S.shock = { on: Math.abs(lastRet) > 2.5 * dailySd, lastRet, ratio: dailySd > 0 ? Math.abs(lastRet) / dailySd : 0 };

  // Input Kompas Penjual (SELLER_DIRECTIONAL_ALPHA.md): trend, drawdown, RSI(14).
  if (allCloses.length >= 101) {
    const last = allCloses[allCloses.length - 1];
    const ma100 = allCloses.slice(-100).reduce((a, b) => a + b, 0) / 100;
    const hi90 = Math.max(...allCloses.slice(-90));
    // RSI(14) dengan smoothing Wilder di seluruh window
    let avgG = 0, avgU = 0;
    for (let i = 1; i <= 14; i++) {
      const d = allCloses[i] - allCloses[i - 1];
      avgG += Math.max(d, 0) / 14; avgU += Math.max(-d, 0) / 14;
    }
    for (let i = 15; i < allCloses.length; i++) {
      const d = allCloses[i] - allCloses[i - 1];
      avgG = (avgG * 13 + Math.max(d, 0)) / 14;
      avgU = (avgU * 13 + Math.max(-d, 0)) / 14;
    }
    const rsi = avgU === 0 ? 100 : 100 - 100 / (1 + avgG / avgU);
    S.trend = { above: last > ma100, ma100, dd90: (last / hi90 - 1) * 100, rsi };
  }
}

async function fetchFundingHist() {
  // 540 rekaman x 8j = 180 hari: rata-rata funding harian 7h + persentilnya dalam window.
  const j = await jget('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=540');
  if (!Array.isArray(j) || j.length < 30) return;
  const byDay = new Map();
  for (const r of j) {
    const d = new Date(r.fundingTime).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + parseFloat(r.fundingRate));
  }
  const days = [...byDay.keys()].sort().map(d => byDay.get(d));
  const avg7arr = [];
  for (let i = 6; i < days.length; i++)
    avg7arr.push(days.slice(i - 6, i + 1).reduce((a, b) => a + b, 0) / 7);
  const cur = avg7arr[avg7arr.length - 1];
  const pct = avg7arr.filter(v => v <= cur).length / avg7arr.length * 100;
  S.fundHist = { avg7: cur, pct };
}

async function fetchDvol() {
  // Indeks DVOL Deribit (IV 30h BTC) â endpoint publik gratis, ~8 hari terakhir untuk trend.
  const end = Date.now(), start = end - 8 * 86400_000;
  const j = await jget('https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=86400&start_timestamp=' + start + '&end_timestamp=' + end);
  const d = j.result?.data || [];                        // [ts, open, high, low, close]
  if (d.length) {
    S.dvol = d[d.length - 1][4];
    S.dvolPrev = d.length > 1 ? d[d.length - 2][4] : null;
  }
}

async function fetchFunding() {
  const j = await jget('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
  S.funding = parseFloat(j.lastFundingRate);
}

async function fetchSnapshots() {
  // Snapshot GH-Actions; toleransi jika belum ada (mis. clone baru).
  try { S.kronos = await jget('data/kronos.json?_=' + Date.now()); } catch (_) {}
  try {
    const local = await jget('data/kronos_local.json?_=' + Date.now());
    // utamakan output model lokal jika lebih baru
    if (local && (!S.kronos || (local._updatedMs || 0) > (S.kronos._updatedMs || 0))) S.kronos = local;
  } catch (_) {}
  try { S.fng = await jget('data/fg.json?_=' + Date.now()); } catch (_) {}
  try { S.finbert = await jget('data/sentiment.json?_=' + Date.now()); } catch (_) {}
  try { S.seas = await jget('data/vol_seasonality.json?_=' + Date.now()); } catch (_) {}
}

/* ------------------------- jam trading (musiman) -------------------- */
// Studi 2015-2026: RV tahunan terkompresi ~69%->48% pasca-ETF; jam UTC paling
// sepi 03-05 & 09-11; paling ramai 13-16 (rilis makro AS + buka pasar tunai);
// weekend berjalan pada ~64% vol hari kerja. Lihat BTC_VOL_RESEARCH.md untuk bukti lengkap.
function renderClock() {
  const el = document.getElementById('clockNow');
  if (!el) return;
  const s = S.seas;
  const now = new Date();
  const h = now.getUTCHours(), dow = (now.getUTCDay() + 6) % 7; // Senin=0
  const days = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  if (!s || !s.hourVolBpsPostEtf) {
    el.textContent = 'Snapshot musiman belum tersedia â jalankan workflow fetch-data sekali.';
    return;
  }
  const hv = s.hourVolBpsPostEtf;
  const vals = Object.keys(hv).map(k => hv[k]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const cur = hv[String(h)];
  const quiet = (s.quietHoursUtc || []).includes(h);
  const loud  = (s.loudHoursUtc  || []).includes(h);
  const wknd  = dow >= 5;
  const regime = loud ? ['JAM RAMAI', 'neg'] : quiet ? ['JAM SEPI', 'pos'] : ['JAM NORMAL', 'warn'];
  el.innerHTML =
    `Sekarang <b>${String(h).padStart(2,'0')}:00 UTC, ${days[dow]}</b> â secara historis termasuk ` +
    `<b class="${regime[1]}">${regime[0]}</b> (${cur} bps/jam vs rentang ${min}â${max})` +
    (wknd ? ` &middot; <b class="pos">WEEKEND</b>: vol berjalan pada ~${Math.round((s.weekendVolRatio || 0.64) * 100)}% dari hari kerja â wilayah panen theta` : '');

  // 24 mini bar
  const bars = document.getElementById('clockBars');
  if (bars) {
    bars.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const v = hv[String(i)] ?? min;
      const pct = Math.max(8, Math.round((v - min) / (max - min) * 100));
      const d = document.createElement('div');
      d.style.cssText = `flex:1;height:${pct}%;border-radius:2px 2px 0 0;` +
        `background:${i === h ? '#5b8cff' : (s.loudHoursUtc || []).includes(i) ? 'rgba(248,81,73,.7)' : (s.quietHoursUtc || []).includes(i) ? 'rgba(63,185,80,.7)' : 'rgba(139,148,158,.45)'}`;
      d.title = `${String(i).padStart(2,'0')}:00 UTC â ${v} bps/jam`;
      bars.appendChild(d);
    }
  }

  const adv = document.getElementById('clockAdvice');
  if (adv) {
    const mon = now.getUTCMonth() + 1;
    const mrv = s.monthRv ? s.monthRv[String(mon)] : null;
    const mAvg = s.monthRv ? Object.values(s.monthRv).reduce((a, b) => a + b, 0) / 12 : null;
    const lines = [];
    if (loud)  lines.push('ð´ <b>Jam sesi AS (13â16 UTC).</b> Di sinilah rilis CPI/NFP dan pembukaan NYSE terjadi â 4 jam paling ramai dalam sehari. <b>Pembeli straddle</b> sebaiknya sudah punya posisi sebelum jendela ini pada hari makro; penjual sebaiknya sudah ter-hedge atau flat.');
    if (quiet) lines.push('ð¢ <b>Secara statistik periode paling sepi dalam sehari.</b> Jika Risk Gate di atas HIJAU, ini saat entry short-premium secara historis mengalami pergerakan merugikan paling kecil.');
    if (!loud && !quiet) lines.push('ð¡ Jam menengah â tidak ada edge statistik ke arah manapun; biarkan Risk Gate yang menentukan.');
    if (dow === 4) lines.push('ð <b>Jumat:</b> jendela income klasik terbuka setelah penutupan AS (~21:00 UTC) â weekend hanya merealisasikan ~64% vol hari kerja, satu-satunya overpay struktural di opsi BTC. Jual hanya dengan gate HIJAU + exit yang jelas; buku weekend yang tipis masih bisa gap.');
    if (dow === 3) lines.push('ð <b>Kamis:</b> secara historis hari kerja paling ramai pada closing harian â menguntungkan pembeli straddle saat IV murah.');
    if (mrv != null && mAvg != null) {
      lines.push(`ð Bulan ini secara historis berjalan <b>${mrv}%</b> annualized vs rata-rata ${mAvg.toFixed(0)}% â ${mrv < mAvg * 0.9 ? 'condong musim tenang (ramah theta)' : mrv > mAvg * 1.1 ? 'condong musim badai (waspadai tail, utamakan risiko terdefinisi)' : 'kira-kira rata-rata'}.`);
    }
    if (s.clustering) lines.push(`ð Vol berkelompok: setelah hari sepi ada peluang ${Math.round(s.clustering.pQuietAfterQuiet * 100)}% hari berikutnya juga sepi â rezim cenderung bertahan, jadi jangan melawan tape kemarin.`);
    lines.push(`<span style="color:var(--dim)">Fakta era pasca-ETF: vol realized terkompresi dari ~69% (2020â23) menjadi ~48% â BTC makin tenang seiring dana ETF memperdalam likuiditas, tapi tetap ~3Ã vol indeks saham. Studi lengkap: BTC_VOL_RESEARCH.md.</span>`);
    adv.innerHTML = lines.map(l => '&bull; ' + l).join('<br>');
  }
}

/* --------------------------- pengayaan chain ---------------------------- */
function enrich(expiryMs) {
  const T = (expiryMs - Date.now()) / (365 * 86400_000);
  const F = S.spot;
  const rows = S.chainByExpiry.get(expiryMs) || [];
  for (const r of rows) {
    r.callIv = r.callMark != null ? impliedVol(r.callMark, F, r.strike, T, true)  : null;
    r.putIv  = r.putMark  != null ? impliedVol(r.putMark,  F, r.strike, T, false) : null;
    r.callDelta = r.callIv ? black76Delta(F, r.strike, T, r.callIv, true)  : null;
    r.putDelta  = r.putIv  ? black76Delta(F, r.strike, T, r.putIv,  false) : null;
  }
  return { rows, T };
}

function atmIv(rows) {
  if (!rows.length || !S.spot) return null;
  const atm = rows.reduce((a, b) =>
    Math.abs(b.strike - S.spot) < Math.abs(a.strike - S.spot) ? b : a);
  const ivs = [atm.callIv, atm.putIv].filter(v => v != null);
  return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
}

/* --------------------------- pembuat strangle ---------------------------- */
function pickLeg(rows, targetAbsDelta, side) {
  // side 'P': delta di (-1,0); 'C': delta di (0,1). Pilih leg OTM terdekat target.
  let best = null, bestErr = Infinity;
  for (const r of rows) {
    const d = side === 'P' ? r.putDelta : r.callDelta;
    const mark = side === 'P' ? r.putMark : r.callMark;
    if (d == null || mark == null || mark <= 0) continue;
    if (side === 'P' && r.strike >= S.spot) continue;   // OTM saja
    if (side === 'C' && r.strike <= S.spot) continue;
    const err = Math.abs(Math.abs(d) - targetAbsDelta);
    if (err < bestErr) { bestErr = err; best = r; }
  }
  return best;
}

function deltaExMarginPerLeg(strike, premiumUsd, isPut) {
  // Heuristik margin short-option Delta Exchange (didokumentasikan di footer; VERIFIKASI di
  // kalkulator mereka): max(15% Ã spot â jarak OTM, 7.5% Ã spot) + premi.
  const spot = S.spot;
  const otm = isPut ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  return Math.max(0.15 * spot - otm, 0.075 * spot) + premiumUsd;
}

/* ------------------------------ risk gate -------------------------------- */
function computeGate(atm) {
  const why = [];
  let score = 0; // positif = mendukung penjualan premi

  const ivhv = (atm && S.hv20) ? atm / S.hv20 : null;
  if (ivhv != null) {
    if (ivhv >= 1.25) { score += 2; why.push(`IV/HV ${ivhv.toFixed(2)} â premi gemuk vs realized (edge ke penjual)`); }
    else if (ivhv >= 1.05) { score += 1; why.push(`IV/HV ${ivhv.toFixed(2)} â premi risiko-vol sedang`); }
    else { score -= 2; why.push(`IV/HV ${ivhv.toFixed(2)} â opsi MURAH vs realized; menjual tidak punya edge statistik`); }
  }

  const volAmp = S.kronos?.volAmp;
  if (volAmp != null) {
    if (volAmp >= 80) { score -= 2; why.push(`BGTC vol-amplification ${volAmp}% â model memperkirakan vol realized akan MENGEMBANG; short gamma berbahaya`); }
    else if (volAmp >= 60) { score -= 1; why.push(`BGTC vol-amplification ${volAmp}% â risiko ekspansi meningkat`); }
    else { score += 1; why.push(`BGTC vol-amplification ${volAmp}% â vol diperkirakan tenang`); }
  }

  const up = S.kronos?.upside;
  if (up != null && (up >= 70 || up <= 30)) {
    score -= 1; why.push(`Skew terarah BGTC (upside ${up}%) â strangle delta-neutral melawan model terarah`);
  }

  const fv = S.fng?.value;
  if (fv != null) {
    if (fv <= 15 || fv >= 88) { score -= 1; why.push(`Fear & Greed ${fv} â pembacaan ekstrem sering diikuti pergerakan besar; lebarkan strike atau kurangi ukuran`); }
    else { score += 1; why.push(`Fear & Greed ${fv} â mid-regime, ramah mean-reversion`); }
  }

  const fb = S.finbert;
  if (fb && fb.score != null && Math.abs(fb.score) > 0.35) {
    score -= 1;
    why.push(`Sentimen berita FinBERT ${fb.score > 0 ? '+' : ''}${fb.score} (${fb.label}, ${fb.n} headline) â arus berita sepihak yang kuat memicu tren, musuh strangle`);
  } else if (fb && fb.score != null) {
    why.push(`Sentimen berita FinBERT ${fb.score > 0 ? '+' : ''}${fb.score} (${fb.label}) â arus berita seimbang`);
  }

  if (S.funding != null && Math.abs(S.funding) > 0.0003) {
    score -= 1; why.push(`Funding ${(S.funding * 100).toFixed(4)}%/8j â posisi perp padat, risiko squeeze`);
  } else if (S.funding != null) {
    why.push(`Funding ${(S.funding * 100).toFixed(4)}%/8j â positioning netral`);
  }

  let cls, label;
  if (score >= 2)      { cls = 'v-sell';    label = 'HIJAU â kondisi mendukung penjualan premi (ukuran normal)'; }
  else if (score >= 0) { cls = 'v-caution'; label = 'AMBER â jual hanya strike lebar dengan ukuran dikurangi'; }
  else                 { cls = 'v-stand';   label = 'MERAH â stand down / hanya buy-side atau spread'; }
  return { score, cls, label, why, ivhv };
}

/* --------------------------- catatan desk (bahasa sederhana) ------------------ */
/* Lapisan terjemahan: mengubah angka yang sama yang dibaca desk fund menjadi
   kalimat yang bisa langsung dieksekusi trader ritel tahun pertama. Tanpa jargon tanpa penjelasan. */
function renderDeskNotes(gate, atm, em, T) {
  const el = document.getElementById('deskNotes');
  if (!el) return;
  const p = [];

  // 1. Posisi sekarang
  if (S.spot) {
    const emPct = em != null ? (em / S.spot * 100).toFixed(1) : null;
    p.push(`<b>Posisi sekarang.</b> Bitcoin diperdagangkan di <b>${fmt$(S.spot)}</b>. ` +
      (emPct != null
        ? `Pasar opsi memberi harga untuk pergerakan normal sekitar <b>&plusmn;${emPct}%</b> (&plusmn;${fmt$(em)}) dari sekarang sampai expiry ini. Anggap ini sebagai ramalan cuaca pasar sendiri â kira-kira 2 dari 3 hari, harga seharusnya tetap dalam rentang itu.`
        : `Data chain masih memuat, jadi belum ada estimasi expected-move.`));
  }

  // 2. Apakah premi mahal atau murah?
  if (gate.ivhv != null) {
    if (gate.ivhv >= 1.15) {
      p.push(`<b>Apakah menjual layak?</b> Opsi saat ini diberi harga <b>${((gate.ivhv - 1) * 100).toFixed(0)}% lebih mahal</b> dibanding pergerakan aktual Bitcoin (IV ${fmtPct(atm)} vs realized ${fmtPct(S.hv20)}). Selisih itu adalah <i>premi risiko-vol</i> â "markup asuransi" yang Anda kumpulkan sebagai penjual. Hari ini markup itu ada.`);
    } else if (gate.ivhv >= 1.0) {
      p.push(`<b>Apakah menjual layak?</b> Opsi diberi harga hanya sedikit di atas pergerakan realized (IV ${fmtPct(atm)} vs ${fmtPct(S.hv20)}). Edge penjual tipis â seperti menjual asuransi mendekati harga pokok. Cukup, tidak istimewa.`);
    } else {
      p.push(`<b>Apakah menjual layak?</b> <span class="neg">Tidak.</span> Opsi diberi harga <i>lebih murah</i> dari pergerakan aktual Bitcoin (IV ${fmtPct(atm)} vs ${fmtPct(S.hv20)}). Menjual di sini artinya menjual asuransi di bawah harga pokok â edge statistik hari ini milik pembeli.`);
    }
  }

  // 3. Ramalan AI
  if (S.kronos?.volAmp != null) {
    const va = S.kronos.volAmp, up = S.kronos.upside;
    if (va >= 80) {
      p.push(`<b>Yang dilihat AI.</b> Model BGTC (NOCTUA, dilatih pada 12 miliar titik data finansial) memberi <b class="neg">peluang ${va}% volatilitas MENGEMBANG</b> dalam 24 jam ke depan${up != null ? ` dan peluang ${up}% harga berakhir lebih tinggi` : ''}. Ekspansi volatilitas adalah hal yang paling merugikan penjual opsi â ini peringatan badai. Saat angka ini di atas 80, fund memotong buku short-vol mereka, bukan menambahnya.`);
    } else if (va >= 60) {
      p.push(`<b>Yang dilihat AI.</b> BGTC memberi peluang ekspansi vol sebesar <b class="warn">${va}%</b>${up != null ? ` (upside ${up}%)` : ''} â lebih bergejolak dari ideal. Penjual sebaiknya melebarkan strike dan memperkecil ukuran.`);
    } else {
      p.push(`<b>Yang dilihat AI.</b> BGTC memperkirakan kondisi tenang: hanya ${va}% peluang volatilitas mengembang${up != null ? `, upside ${up}%` : ''}. Tape yang sepi adalah sahabat terbaik penjual premi.`);
    }
  }

  // 4. Crowd + berita
  const crowd = [];
  if (S.fng?.value != null) {
    const fv = S.fng.value;
    crowd.push(fv <= 20 ? `pasar sedang dalam <b class="neg">${S.fng.label || 'Ketakutan Ekstrem'}</b> (${fv}/100) â secara historis zona rally snap-back yang keras`
      : fv >= 80 ? `pasar sedang dalam <b class="warn">${S.fng.label || 'Keserakahan Ekstrem'}</b> (${fv}/100) â euforia sering mendahului air-pocket`
      : `mood pasar berada di tengah (${fv}/100) â tidak ada ekstrem emosional untuk di-fade atau ditakuti`);
  }
  if (S.finbert?.score != null) {
    crowd.push(`sentimen berita hasil baca AI (FinBERT) adalah <b>${S.finbert.label}</b> (${S.finbert.score > 0 ? '+' : ''}${S.finbert.score})`);
  }
  if (S.funding != null) {
    crowd.push(Math.abs(S.funding) > 0.0003
      ? `funding perp di ${(S.funding * 100).toFixed(4)}%/8j menunjukkan sisi ${S.funding > 0 ? 'long' : 'short'} yang padat â bahan bakar squeeze`
      : `funding perp netral â tidak ada sisi padat untuk di-squeeze`);
  }
  if (crowd.length) p.push(`<b>Pasar (crowd).</b> ${crowd.join('; ')}.`);

  // 5. Instruksi
  if (gate.cls === 'v-sell') {
    p.push(`<b>Intinya.</b> <span class="pos">Kondisi mendukung penjualan premi.</span> Pembuat strangle di bawah sudah memilih strike yang dikenali desk fund: cukup jauh untuk menang ~${document.getElementById('pop')?.textContent || '70%+'} dari waktu, cukup dekat untuk dibayar atas risikonya. Masuk, tetapkan aturan exit, dan biarkan matematikanya bekerja.`);
  } else if (gate.cls === 'v-caution') {
    p.push(`<b>Intinya.</b> <span class="warn">Bisa ditradingkan, tapi dengan porsi separuh.</span> Jual strike yang lebih lebar (turunkan target |&Delta;| ke 0.10), potong lot separuh, dan ambil profit lebih awal di 50% dari kredit. Edge-nya ada tapi cuacanya belum stabil.`);
  } else {
    p.push(`<b>Intinya.</b> <span class="neg">Stand down.</span> Ini hari untuk TIDAK menjual opsi telanjang (naked) â trade paling menguntungkan sebuah desk sering kali adalah trade yang tidak pernah dipasang. Jika harus trading, gunakan spread berisiko terdefinisi (beli wing lebih jauh terhadap tiap leg short) sehingga pergerakan liar tidak bisa merugikan Anda melebihi jumlah yang sudah diketahui. Cek lagi besok; rezim bisa berbalik cepat.`);
  }

  el.innerHTML = p.map(x => `<p style="margin:0 0 9px">${x}</p>`).join('');

  const g = document.getElementById('deskGlossary');
  if (g) g.innerHTML =
    `<b>Glosarium 30 detik:</b> <i>IV</i> = seberapa besar pergerakan yang di-charge opsi &middot; ` +
    `<i>Realized/HV</i> = seberapa besar pergerakan yang benar-benar terjadi &middot; ` +
    `<i>&Delta; (delta)</i> â peluang opsi berakhir in-the-money (0.15&Delta; â 15%) &middot; ` +
    `<i>POP</i> = probabilitas seluruh trade untung &middot; ` +
    `<i>Strangle</i> = jual satu put di bawah + satu call di atas; Anda menang jika harga tetap di antara keduanya.`;
}

/* ------------------------------ rendering -------------------------------- */
function expLabel(ms) {
  const d = new Date(ms);
  const days = ((ms - Date.now()) / 86400_000).toFixed(1);
  return d.toISOString().slice(0, 10) + ` (${days}h)`;
}

/* --------------------------- Radar Pembeli -------------------------------
   Backtest (OPTION_BUYER_ALPHA.md, pasca-ETF, biaya dari DVOL Deribit riil):
   - DVOL < 40  -> straddle 10h menang 45.9% vs baseline 33.7%, rata-rata EV +0.95%/trade
                   (monoton: <38 lebih baik lagi, >60 bencana -2.94%). p=0.0001.
   - Hari shock -> straddle 5h menang 43.2% vs 35.0%, EV +0.34%, p=0.044 (n=37).
   - Squeeze BBW, streak sepi, taruhan arah breakout: TIDAK ADA edge begitu diberi harga
     dengan IV riil â pasar sudah mengenakan biaya untuk coil itu. Dilaporkan jujur.   */
function renderBuyerRadar() {
  const el = $('radarVerdict');
  if (!el) return;
  const dv = S.dvol, sh = S.shock;
  $('radarDvol').textContent = dv != null ? dv.toFixed(1) + (S.dvolPrev != null ? ` (${dv >= S.dvolPrev ? '+' : ''}${(dv - S.dvolPrev).toFixed(1)} h/h)` : '') : 'â';
  $('radarDvol').className = dv == null ? '' : dv < 40 ? 'pos' : dv < 50 ? 'warn' : 'neg';
  $('radarShock').textContent = sh ? (sh.on ? `YA â pergerakan ${(sh.lastRet * 100).toFixed(1)}% (${sh.ratio.toFixed(1)}Ã normal)` : `tidak (hari terakhir ${(sh.lastRet * 100).toFixed(1)}%, ${sh.ratio.toFixed(1)}Ã normal)`) : 'â';
  $('radarShock').className = sh?.on ? 'warn' : '';

  let cls, label, why = [];
  if (dv == null) { cls = 'v-caution'; label = 'DATA DVOL TIDAK ADA'; why.push('Fetch DVOL Deribit gagal â radar offline untuk refresh ini.'); }
  else if (dv < 40) {
    cls = 'v-sell'; label = 'ZONA BELI â implied vol secara statistik terlalu murah';
    why.push(`DVOL ${dv.toFixed(1)} < 40: pasca-ETF, straddle 10 hari yang dibeli di sini menang 45.9% vs baseline 33.7% dan rata-rata +0.95% dari spot per trade â satu-satunya kondisi pembeli dengan EV positif yang bertahan (p=0.0001).`);
    why.push('Cara main: straddle ATM 7â14 hari atau strangle 25Î, ukuran kecil, tahan sampai pergerakan terjadi. Pasar memberi harga BTC seperti saham yang tenang; BTC punya lantai vol.');
  } else if (dv < 50) {
    cls = 'v-caution'; label = 'NETRAL â beli hanya dengan alasan';
    why.push(`DVOL ${dv.toFixed(1)} di 40â50: EV kira-kira datar (-0.2%). Beli hanya menjelang rilis makro terjadwal (CPI/NFP 12:30 UTC, FOMC 18:00 UTC) di dalam expiry Anda, atau pada hari shock baru.`);
  } else {
    cls = 'v-stand'; label = "TERLALU MAHAL â jangan beli ketakutan";
    why.push(`DVOL ${dv.toFixed(1)} > 50: pembeli rugi rata-rata ${dv >= 60 ? '-2.94%' : '-1.41%'} per straddle 10h di zona ini. Premi ITU SENDIRI adalah kepanikan â ini panen penjual, bukan lotere pembeli.`);
  }
  if (sh?.on) why.push(`Hari shock baru saja tercetak (${(sh.lastRet * 100).toFixed(1)}%): vol cenderung berkelompok â straddle 5 hari yang dimasuki pada penutupan shock menang 43.2% vs baseline 35.0% (edge kecil, n=37; dealer me-remark IV dengan jeda).`);
  why.push('Yang TIDAK bekerja (terverifikasi): squeeze Bollinger, "tiga hari sepi", dan taruhan arah breakout semuanya menunjukkan edge nol begitu diberi harga dengan implied vol riil â coil sudah ada dalam premi. Lihat OPTION_BUYER_ALPHA.md.');

  el.textContent = label;
  el.className = 'verdict ' + cls;
  $('radarWhy').innerHTML = why.map(w => '&bull; ' + w).join('<br>');
}

/* Kompas Penjual â rezim penjualan opsi terarah, backtest short 25Î mingguan
   diberi harga pada DVOL riil (SELLER_DIRECTIONAL_ALPHA.md, 894 hari):
   - PRIME  : dd90 < -15% DAN DVOL > 50  -> put EV +0.95%/mgg, menang 92.7%, terburuk -3.5% (p=0.0000)
   - GOOD   : uptrend & DVOL>50 (+0.81%) | funding 7h<0 (+0.81%) | funding<20pctil (+0.73%)
   - ANTI   : hari shock (-1.04%, p=.015), RSI<30 (-0.78%, p=.0002), RSI>70 call (-0.62%),
              strangle DVOL<40 (-0.47%) â semua signifikan MERUGIKAN untuk penjual.
   - Penjualan terarah sisi call sendirian: p=0.18, TIDAK tervalidasi â dilaporkan jujur. */
function renderSellerCompass() {
  const el = $('scVerdict');
  if (!el) return;
  const t = S.trend, f = S.fundHist, dv = S.dvol, sh = S.shock;

  $('scTrend').textContent = t ? `${t.above ? 'NAIK (di atas MA100)' : 'TURUN (di bawah MA100)'} &middot; ${t.dd90.toFixed(1)}% dari tertinggi 90h` : 'â';
  $('scTrend').className = t ? (t.above ? 'pos' : 'neg') : '';
  $('scFund').textContent = f ? `${(f.avg7 * 100).toFixed(4)}%/hari (rata-rata 7h) &middot; persentil ke-${f.pct.toFixed(0)} (180h)` : 'â';
  $('scFund').className = f ? (f.avg7 < 0 || f.pct < 20 ? 'pos' : f.pct > 80 ? 'warn' : '') : '';
  $('scRsi').textContent = t ? t.rsi.toFixed(0) : 'â';
  $('scRsi').className = t ? (t.rsi < 30 || t.rsi > 70 ? 'neg' : '') : '';

  let cls, label, why = [];
  const anti = [];
  if (sh?.on) anti.push(`hari shock baru saja tercetak (${(sh.lastRet * 100).toFixed(1)}%) â menjual put di hari shock rugi -1.04%/mgg (p=0.015); ketakutan harus jadi PERSISTEN dulu`);
  if (t && t.rsi < 30) anti.push(`RSI ${t.rsi.toFixed(0)} < 30 â "oversold" tetap terus turun: jual put di sini rugi -0.78%/mgg (p=0.0002)`);
  if (t && t.rsi > 70) anti.push(`RSI ${t.rsi.toFixed(0)} > 70 â jangan pernah membatasi rally yang panas: jual call di sini rugi -0.62%/mgg (p=0.0007)`);
  if (dv != null && dv < 40) anti.push(`DVOL ${dv.toFixed(1)} < 40 â vol terlalu murah untuk dijual (strangle rugi -0.47%/mgg di sini, p=0.0007). Ini zona Radar Pembeli.`);

  const prime = t && dv != null && t.dd90 < -15 && dv > 50;
  const good = [];
  if (t && dv != null && t.above && dv > 50) good.push(`uptrend + DVOL>50 ("dibayar dua kali"): put EV +0.81%/mgg, menang 89% (p=0.0000)`);
  if (f && f.avg7 < 0) good.push(`funding 7h negatif â leverage sudah dikuras: put EV +0.81%/mgg, menang 90%, minggu terburuk hanya -5.0%`);
  else if (f && f.pct < 20) good.push(`funding persentil ke-${f.pct.toFixed(0)} (crowd dingin): put EV +0.73%/mgg, menang 90% (p=0.0005)`);

  if (anti.length) {
    cls = 'v-stand'; label = 'STAND ASIDE â anti-signal aktif';
    why = anti.map(a => 'Diblokir: ' + a);
    if (prime || good.length) why.push('Filter yang sebenarnya bisa aktif: ' + (prime ? 'zona ketakutan PRIME; ' : '') + good.join('; ') + ' â anti-signal menang; trade sama, minggu yang salah.');
  } else if (prime) {
    cls = 'v-sell'; label = 'PRIME â jual put ke dalam ketakutan yang persisten';
    why.push(`Drawdown ${t.dd90.toFixed(1)}% + DVOL ${dv.toFixed(1)}: crash sudah terjadi tapi ketakutan masih ter-price. Put 25Î 7h: +0.95%/mgg, menang 92.7%, minggu terburuk -3.5% (p=0.0000; 14h bahkan lebih baik: menang 96.7%). Trade penjual dengan risk-adjusted terbaik di seluruh studi.`);
  } else if (good.length) {
    cls = 'v-sell'; label = 'GOOD â jual put, kondisi tervalidasi';
    why = good.map(g => '' + g);
  } else if (dv != null && dv > 55) {
    cls = 'v-caution'; label = 'NEUTRAL-PLUS â zona panen strangle';
    why.push(`Tidak ada filter arah aktif, tapi DVOL ${dv.toFixed(1)} > 55: strangle 25Î non-arah menghasilkan +1.21%/mgg (p=0.0000) â dengan risiko fat-tail penuh -21% kembali aktif. Sesuaikan ukuran.`);
  } else {
    cls = 'v-caution'; label = 'NETRAL â hanya premi baseline';
    why.push('Tidak ada rezim tervalidasi yang aktif. Penjualan put 25Î tanpa syarat masih menghasilkan ~+0.33%/mgg (premi varians standar), tapi dengan minggu terburuk -21%. Entry lebih baik akan datang bagi yang sabar menunggu.');
  }

  // BGTC: overlay live, secara jujur belum di-backtest (tidak ada arsip ramalan).
  const ku = S.kronos?.upside;
  if (ku != null && (cls === 'v-sell')) {
    why.push(ku >= 55 ? `Overlay BGTC: probabilitas upside ${ku}% setuju â ukuran penuh yang direncanakan masih masuk akal.`
           : ku <= 45 ? `Overlay BGTC: hanya probabilitas upside ${ku}% â pertimbangkan setengah ukuran. (Overlay hanya live; BGTC belum punya riwayat yang bisa di-backtest.)`
           : `Overlay BGTC: probabilitas upside ${ku}%, netral â tidak ada penyesuaian ukuran.`);
  }
  why.push(`Catatan kejujuran: edge terarah hanya di sisi PUT â "jual call saat downtrend" gagal signifikan (p=0.18). Skew berarti kredit put riil lebih gemuk dari model. Lihat SELLER_DIRECTIONAL_ALPHA.md.`);

  el.textContent = label;
  el.className = 'verdict ' + cls;
  $('scWhy').innerHTML = why.map(w => (w.startsWith('\u2022') ? w : '&bull; ' + w)).join('<br>');
}

/* Desk Harian â penjualan 1DTE (DAILY_EXPIRY_ALPHA.md, 998 expiry harian pada DVOL riil).
   Settlement tiap hari 12:00 UTC = 17:30 IST di Delta Exchange.
   - PRIME : entry-Sabtu (expiry Minggu siang) straddle +1.20%/h, menang 92.3%, terburuk -3.2% (p=0.0000)
             tapi meluruh: 2023 +1.50 -> 2026 +0.55 â trading dengan SETENGAH ukuran.
   - JUNIOR: entry-Jumat (expiry Sabtu siang) straddle +0.65%/h (p=0.033).
   - ANTI  : entry Senin (expiry Selasa siang) strangle -0.095%/h (p=0.006); hari shock; put RSI<30 -0.41%/h (p=0.009).
   - GOOD  : put uptrend +0.21-0.23%/h (p<0.006); funding7<0 put +0.26%/h, menang 92%.
   - FLIP  : strangle DVOL<40 adalah +0.25%/h di 1DTE â aturan no-sell mingguan TIDAK berlaku.
   - Jam entry: entry 18:00 UTC mengalahkan hold 24 jam (+0.56% vs +0.40%); entry 06:00 UTC = EV sama, 1/4 tail. */
function renderDailyDesk() {
  const el = $('ddVerdict');
  if (!el) return;
  const t = S.trend, f = S.fundHist, dv = S.dvol, sh = S.shock;
  const now = new Date();
  const todayNoon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  const expiryMs = now.getTime() < todayNoon ? todayNoon : todayNoon + 86400_000;
  const expDow = new Date(expiryMs).getUTCDay();            // 0=Minggu..6=Sabtu (hari UTC saat expiry siang)
  const hrsLeft = (expiryMs - now.getTime()) / 3600_000;
  const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  $('ddWindow').textContent = `${days[expDow]} 12:00 UTC (${hrsLeft.toFixed(1)}j lagi) â jendela = ${days[(expDow + 6) % 7]} siang â ${days[expDow]} siang`;

  // Baris jam entry (studi: varians menumpuk di sesi AS setelah listing)
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  let clockTxt, clockCls = '';
  if (utcH >= 12 && utcH < 18) { clockTxt = `Sesi AS berlangsung â 31% varians hari ini terbakar di 6 jam pertama. Entry sabar di 18:00 UTC (23:30 WIB) secara historis menghasilkan LEBIH BANYAK (+0.56% vs +0.40%) dengan bom yang lebih kecil.`; clockCls = 'warn'; }
  else if (utcH >= 18 || utcH < 2) { clockTxt = `Zona entry utama (18:00â02:00 UTC): jam AS yang ramai sudah lewat; EV entry 18h +0.56%/trade, terburuk -13% vs -16% untuk sehari penuh.`; clockCls = 'pos'; }
  else if (utcH >= 2 && utcH < 9) { clockTxt = `Entry pagi (06:00 UTC / 13:00 WIB, ~6j tersisa): EV sama dengan sehari penuh (+0.40%) dengan seperempat kerugian terburuk (-4.3%). Entry untuk penjual yang gugup.`; clockCls = 'pos'; }
  else { clockTxt = `Jendela akhir (<3j): EV +0.29%/trade, tipis tapi cepat. Cek spread quote â buku menipis menjelang settlement.`; }
  $('ddHours').textContent = clockTxt;
  $('ddHours').className = clockCls;

  // IV ATM tenor terpendek live vs DVOL â seberapa besar edge sudah ter-price
  let ivLine = 'chain 1 hari belum dimuat', ivCls = '';
  try {
    const exps = [...S.chainByExpiry.keys()].filter(e => e > Date.now()).sort((a, b) => a - b);
    if (exps.length && dv != null) {
      const { rows } = enrich(exps[0]);
      const iv = atmIv(rows);
      if (iv != null) {
        const ratio = iv * 100 / dv;
        ivLine = `IV ATM expiry terdekat ${(iv * 100).toFixed(0)}% vs DVOL ${dv.toFixed(0)} â ${ratio.toFixed(2)}Ã`;
        if (ratio <= 0.60) { ivLine += ' â IV tenor pendek sudah tergerus: pasar SUDAH memberi harga jendela tenang; EV backtest adalah batas atas, harapkan lebih sedikit.'; ivCls = 'warn'; }
        else if (ratio >= 0.90) { ivLine += ' â IV tenor pendek mendekati level 30h: diskon kalender BELUM ter-price; edge backtest masih hidup.'; ivCls = 'pos'; }
        else { ivLine += ' â diskon parsial (tipikal): kira-kira separuh edge struktural tersisa.'; }
      }
    }
  } catch (e) { /* chain belum siap */ }
  $('ddIv').textContent = ivLine;
  $('ddIv').className = ivCls;

  let cls, label, why = [];
  const anti = [];
  if (sh?.on) anti.push(`hari shock baru saja tercetak (${(sh.lastRet * 100).toFixed(1)}%) â jangan pernah jual sehari setelah shock; kepanikan baru adalah salah satu dari dua cara penjual harian mati`);
  if (t && t.rsi < 30) anti.push(`RSI ${t.rsi.toFixed(0)} < 30 â tetap racun di 1 hari: jual put di sini rugi -0.41%/h (p=0.009)`);
  if (expDow === 2) anti.push(`jendela entry-Senin (expiry Selasa siang): seluruh berita akhir pekan re-price lewat sesi AS penuh â strangle -0.095%/h (p=0.006). Slot kalender terburuk dalam seminggu.`);

  if (anti.length) {
    cls = 'v-stand'; label = 'STAND ASIDE â anti-signal harian aktif';
    why = anti.map(a => 'Diblokir: ' + a);
  } else if (expDow === 0) {
    cls = 'v-sell'; label = 'PRIME â lull Sabtu: jual straddle ATM / strangle 25Î';
    why.push(`Sabtu siangâMinggu siang hanya merealisasikan 33â45% vol hari kerja tiap tahun sejak 2022 (tanpa sesi AS, tanpa makro, tanpa aliran ETF). Straddle +1.20%/h, menang 92.3%, terburuk -3.2% (p=0.0000); strangle +0.66%/h, menang 93%.`);
    why.push(`Peringatan peluruhan: EV Sabtu 2023 +1.50% â 2026 +0.55%. Edge-nya struktural tapi menyusut â trading dengan SETENGAH ukuran yang disarankan keberanian backtest Anda, dan cek dulu baris IV live di atas.`);
  } else if (expDow === 6) {
    cls = 'v-sell'; label = 'GOOD â entry Jumat: trade weekend junior';
    why.push(`Jumat siangâSabtu siang sudah condong ke lull: straddle +0.65%/h (p=0.033), dan Jumat+Sabtu gabungan berjalan +0.93%/h (p=0.0000). Entry Sabtu besok adalah acara utamanya.`);
  } else if (expDow === 1) {
    cls = 'v-caution'; label = 'CAUTION â entry Minggu: lull TIDAK berlanjut';
    why.push(`Minggu siangâSenin siang mencatat hari terburuk dalam sampel 998 hari: -16.1% (4 Agustus 2024, crash yen-carry akhir pekan). Trade weekend HANYA Sabtu. Jika Anda menjual, ukur seolah malam ini adalah malamnya.`);
  } else {
    const good = [];
    if (t && dv != null && t.above && dv > 50) good.push(`uptrend + DVOL>50: put 25Î +0.23%/h (p=0.004) â filter put harian terbaik yang bertahan`);
    else if (t && t.above) good.push(`uptrend di atas MA100: put 25Î +0.21%/h (p=0.006)`);
    if (f && f.avg7 < 0) good.push(`funding 7h negatif â leverage sudah dikuras: put 25Î +0.26%/h, menang 92%, hari terburuk -3.5%`);
    if (good.length) {
      cls = 'v-sell'; label = 'GOOD â jual put 25Î (terarah harian)';
      why = good.slice();
    } else {
      cls = 'v-caution'; label = 'NETRAL â strangle 25Î, hanya premi gemuk';
      why.push(`Tidak ada filter arah aktif. Strangle 25Î tanpa syarat menghasilkan +0.21%/h bruto, +0.13%/h setelah fee Delta. ${dv != null && dv < 40 ? `DVOL ${dv.toFixed(1)} < 40 BAIK-BAIK saja di 1DTE (+0.25%/h) â aturan no-sell-di-bawah-40 mingguan tidak berlaku untuk harian; proteksi semalam selalu diperdagangkan mahal.` : 'Premi varians tidak pernah hilang sepenuhnya di tenor 1 hari.'}`);
    }
    if (t && t.rsi > 70) why.push(`RSI ${t.rsi.toFixed(0)} > 70 â kehati-hatian sisi call hanya di 1DTE (-0.03%/h, p=0.11): condong sisi put, lewati leg call jika ragu.`);
  }

  // Overlay BGTC (hanya live) pada hari terarah
  const ku = S.kronos?.upside;
  if (ku != null && cls === 'v-sell' && label.includes('put')) {
    why.push(ku >= 55 ? `Overlay BGTC: probabilitas upside ${ku}% setuju â ukuran penuh yang direncanakan masih masuk akal.`
           : ku <= 45 ? `Overlay BGTC: hanya probabilitas upside ${ku}% â setengah ukuran.`
           : `Overlay BGTC: ${ku}% netral â tidak ada penyesuaian.`);
  }
  why.push(`Aturan fee: jual premi GEMUK (ATM/25Î) saja â wing 10Î net-NEGATIF setelah fee Delta (fee memakan 33% bahkan dari put 25Î). Hari terburuk dalam sampel adalah -16% dari notional: atur ukuran agar hari itu menjengkelkan, bukan fatal. Studi lengkap: DAILY_EXPIRY_ALPHA.md.`);

  el.textContent = label;
  el.className = 'verdict ' + cls;
  $('ddWhy').innerHTML = why.map(w => (w.startsWith('Diblokir') ? '&bull; ' + w : '&bull; ' + w)).join('<br>');
}

function renderAll() {
  const expiry = S.selectedExpiry;
  const { rows, T } = enrich(expiry);
  const atm = atmIv(rows);

  $('spot').textContent = fmt$(S.spot);
  $('atmIv').textContent = fmtPct(atm);
  $('hv20').textContent = fmtPct(S.hv20);
  const gate = computeGate(atm);
  $('ivhv').textContent = gate.ivhv != null ? gate.ivhv.toFixed(2) + 'Ã' : 'â';
  $('ivhv').className = gate.ivhv >= 1.15 ? 'pos' : gate.ivhv <= 1.0 ? 'neg' : 'warn';
  const em = (atm != null) ? S.spot * atm * Math.sqrt(T) : null;
  $('expMove').textContent = em != null ? 'Â±' + fmt$(em).slice(1) : 'â';
  $('funding').textContent = S.funding != null ? (S.funding * 100).toFixed(4) + '% /8j' : 'â';

  $('krUp').textContent  = S.kronos?.upside  != null ? S.kronos.upside + '%'  : 'n/a (jalankan snapshot atau bgtc_local)';
  $('krVol').textContent = S.kronos?.volAmp != null ? S.kronos.volAmp + '%' : 'n/a';
  $('krVol').className   = (S.kronos?.volAmp ?? 0) >= 80 ? 'neg' : (S.kronos?.volAmp ?? 0) >= 60 ? 'warn' : 'pos';
  $('fng').textContent   = S.fng?.value != null ? `${S.fng.value} &middot; ${S.fng.label || ''}` : 'n/a';
  $('vrp').textContent   = gate.ivhv != null ? (gate.ivhv >= 1.15 ? 'PRESENT' : gate.ivhv >= 1.0 ? 'THIN' : 'ABSENT') : 'â';

  const v = $('verdict');
  v.textContent = gate.label;
  v.className = 'verdict ' + gate.cls;
  $('verdictWhy').innerHTML = gate.why.map(w => '&bull; ' + w).join('<br>');

  renderStrangle(rows, T, em);
  renderChain(rows, expiry);
  renderDeskNotes(gate, atm, em, T);   // setelah renderStrangle: Catatan Desk membaca angka POP live
  renderClock();                       // musiman jam/hari/bulan dari studi 2015-2026
  renderBuyerRadar();                  // sinyal zona-DVOL + hari-shock untuk pembeli (OPTION_BUYER_ALPHA.md)
  renderSellerCompass();               // rezim penjualan put terarah (SELLER_DIRECTIONAL_ALPHA.md)
  renderDailyDesk();                   // kalender & jam 1DTE (DAILY_EXPIRY_ALPHA.md)
}

function renderStrangle(rows, T, em) {
  const target = +$('deltaSlider').value / 100;
  const lots = +$('lotSlider').value;
  const sizeBtc = lots * 0.001;                       // 1 lot opsi BTC Delta Exchange = 0.001 BTC
  $('deltaVal').textContent = target.toFixed(2);
  $('lotVal').textContent = lots;

  const put = pickLeg(rows, target, 'P');
  const call = pickLeg(rows, target, 'C');
  if (!put || !call) {
    $('putLeg').textContent = $('callLeg').textContent = 'likuiditas chain tidak cukup';
    return;
  }
  S._legs = { put: put.strike, call: call.strike };

  const credit = (put.putMark + call.callMark) * sizeBtc;
  const beLo = put.strike - (put.putMark + call.callMark);
  const beHi = call.strike + (put.putMark + call.callMark);
  const pop = 1 - (Math.abs(put.putDelta) + Math.abs(call.callDelta));

  // margin: penuh pada leg yang mahal, 50% pada yang lebih murah (heuristik keuntungan strangle)
  const mP = deltaExMarginPerLeg(put.strike, put.putMark, true)  * sizeBtc;
  const mC = deltaExMarginPerLeg(call.strike, call.callMark, false) * sizeBtc;
  const margin = Math.max(mP, mC) + 0.5 * Math.min(mP, mC);

  $('putLeg').textContent = `${put.strike.toLocaleString()} P @ ${fmt$(put.putMark)}  (Î ${put.putDelta.toFixed(2)}, IV ${fmtPct(put.putIv)})`;
  $('callLeg').textContent = `${call.strike.toLocaleString()} C @ ${fmt$(call.callMark)}  (Î +${call.callDelta.toFixed(2)}, IV ${fmtPct(call.callIv)})`;
  $('credit').textContent = fmt$(credit) + `  (${sizeBtc} BTC notional/leg)`;
  $('breakevens').textContent = `${fmt$(beLo)}  /  ${fmt$(beHi)}`;
  $('pop').textContent = fmtPct(pop, 0);
  $('margin').textContent = fmt$(margin);
  $('rom').textContent = margin > 0 ? fmtPct(credit / margin) : 'â';
  $('cem').textContent = em ? ((put.putMark + call.callMark) / em).toFixed(2) + 'Ã dari pergerakan 1Ï' : 'â';

  const wingWidthPct = ((call.strike - put.strike) / S.spot * 100).toFixed(1);
  $('legNotes').textContent =
    `Strike membentang ${wingWidthPct}% dari spot. Rencana pertahanan: roll leg yang tertest saat deltanya berlipat dua, ` +
    `atau tutup struktur di 50% dari profit maksimum / kerugian 2Ã kredit â mana yang lebih dulu.`;
}

function renderChain(rows, expiry) {
  $('chainExpiry').textContent = '&middot; ' + expLabel(expiry);
  const tb = $('chainTbl').querySelector('tbody');
  const atmStrike = rows.length ? rows.reduce((a, b) =>
    Math.abs(b.strike - S.spot) < Math.abs(a.strike - S.spot) ? b : a).strike : null;
  tb.innerHTML = rows
    .filter(r => Math.abs(r.strike - S.spot) / S.spot < 0.35)  // jendela &plusmn;35%
    .map(r => {
      const cls = r.strike === atmStrike ? 'atm'
        : (S._legs && (r.strike === S._legs.put || r.strike === S._legs.call)) ? 'leg' : '';
      return `<tr class="${cls}">
        <td>${r.callMark != null ? Math.round(r.callMark) : ''}</td>
        <td>${r.callIv != null ? (r.callIv * 100).toFixed(1) : ''}</td>
        <td>${r.callDelta != null ? r.callDelta.toFixed(2) : ''}</td>
        <td>${r.callOi ? r.callOi.toFixed(0) : ''}</td>
        <td style="text-align:center;font-weight:700">${r.strike.toLocaleString()}</td>
        <td>${r.putOi ? r.putOi.toFixed(0) : ''}</td>
        <td>${r.putDelta != null ? r.putDelta.toFixed(2) : ''}</td>
        <td>${r.putIv != null ? (r.putIv * 100).toFixed(1) : ''}</td>
        <td>${r.putMark != null ? Math.round(r.putMark) : ''}</td>
      </tr>`;
    }).join('');
}

/* ------------------------------ bootstrap -------------------------------- */
let inFlight = false;
async function refresh() {
  if (inFlight) return;
  inFlight = true;
  $('status').textContent = 'memuat chainâ¦';
  try {
    await Promise.allSettled([fetchChain(), fetchHv20(), fetchFunding(), fetchFundingHist(), fetchDvol(), fetchSnapshots()]);
    if (!S.chainByExpiry.size) throw new Error('chain kosong');
    const sel = $('expirySel');
    const keep = S.selectedExpiry;
    sel.innerHTML = [...S.chainByExpiry.keys()].slice(0, 8)
      .map(ms => `<option value="${ms}">${expLabel(ms)}</option>`).join('');
    S.selectedExpiry = (keep && S.chainByExpiry.has(keep)) ? keep : +sel.options[0].value;
    sel.value = S.selectedExpiry;
    renderAll();
    $('status').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.error(e);
    $('status').textContent = 'load failed â ' + e.message;
  } finally {
    inFlight = false;
  }
}

let uiDebounce = null;
function onUi() { clearTimeout(uiDebounce); uiDebounce = setTimeout(renderAll, 80); }

document.addEventListener('DOMContentLoaded', () => {
  $('btnRefresh').addEventListener('click', refresh);
  $('expirySel').addEventListener('change', e => { S.selectedExpiry = +e.target.value; renderAll(); });
  $('deltaSlider').addEventListener('input', onUi);
  $('lotSlider').addEventListener('input', onUi);
  refresh();
  setInterval(refresh, 5 * 60_000);   // auto refresh 5 menit, jauh di dalam batas gratis
});
