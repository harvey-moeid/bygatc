/* =========================================================================
   BTC Futures Risk Desk -- src/futures.js (v2.3)
   v2.3 (Fase 5 checklist -- checklist-upgrade-pro-btc-desk.md):
     - renderBarrierCurves(): "Prob. sentuh" dulu cuma teks berwarna
       (tpClass()) tanpa bar/gauge apapun -- satu-satunya tempat di ketiga
       halaman yang benar-benar tidak punya representasi visual untuk
       sebuah probabilitas. Sekarang tiap sel touch_prob dirender lewat
       probGaugeHtml() (SVG stroke-dashoffset animated, lihat .prob-gauge-fill
       di base.css, komponen sama yang dipakai ui.js untuk odds table &
       retail plan) alih-alih tpClass() inline style pada <td>. Warnanya
       tetap memakai ambang yang sama (tpStrokeColor(), turunan dari
       tpClass() lama) supaya caption "Hijau <15% . Kuning 15-30% .
       Oranye 30-50% . Merah >=50%" di bawah tabel tetap akurat.
   v2.2 (Fase 4 checklist -- checklist-upgrade-pro-btc-desk.md):
     - Angka penting (harga mark/spot, HV20, funding, keyakinan hero)
       sekarang lewat animateValue() (src/animate.js) supaya count-up
       dari nilai lama ke nilai baru saat auto-refresh, bukan lompat
       instan. Funding menampilkan rate + flag dalam satu elemen --
       ratenya dipecah ke <span> tersendiri di dalamnya supaya cuma
       angkanya yang di-animate, flag-nya tetap teks biasa.
     - loadAll() memanggil clearSkeletons() di blok finally sebagai
       jaring pengaman: field yang di-set lewat textContent biasa
       (bukan animateValue) -- panel NOCTUA, Risk Plan -- baru lepas
       class "skel" (shimmer placeholder, lihat base.css) lewat sapuan
       ini setelah satu putaran render selesai, sukses maupun gagal.
   v2.1: hero decision card
     - renderHero(): TRADE OK / CAUTION / NO-TRADE readiness verdict, same
       visual language as the Options desk hero card (index.html + ui.js),
       driven by DataLayer.buildFuturesDecision() so it can never disagree
       with the Risk Plan card below it.
   v2.0: full NOCTUA payload rendering
     - Barrier curves table (up + dn, semua level)
     - Safe levels table (alpha-based strike distances)
     - NOCTUA signal panel (sigma, settle time, calibration)
     - Session context (IST phase)
     - Market panel lebih lengkap
   ========================================================================= */
'use strict';

const FS = {
  price: null, daily: null, hv20: null, funding: null, BGTC: null,
  direction: 'long',
};

let loadInFlight = false;

const $ = (id) => document.getElementById(id);
const fmt$  = (v) => v == null ? '\u2014' : '$' + Math.round(v).toLocaleString();
const fmtPct = (v, d = 2) => v == null ? '\u2014' : v.toFixed(d) + '%';
const or = (v, fb = '\u2014') => (v != null && v !== '' && v !== 'undefined') ? v : fb;

// Premium inline SVG icons (replaces \u2713 / \u26a0 glyph usage)
const ICONS = {
  check:   '<svg class="ic ic-check" viewBox="0 0 20 20" fill="none" width="13" height="13" style="vertical-align:-2px"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M6 10.5l2.5 2.5L14 7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warning: '<svg class="ic ic-warn" viewBox="0 0 20 20" fill="none" width="13" height="13" style="vertical-align:-2px"><path d="M10 2.5l8.5 14.7H1.5L10 2.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="14.6" r="0.9" fill="currentColor"/></svg>',
  dash:    '<svg class="ic ic-dash" viewBox="0 0 20 20" fill="none" width="13" height="13" style="vertical-align:-2px"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M6 10h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ------------------------------ helpers ---------------------------------- */

function tpClass(p) {
  if (p == null) return '';
  if (p >= 0.50) return 'color:var(--red)';
  if (p >= 0.30) return 'color:var(--amb)';
  if (p >= 0.15) return 'color:#e8d44d';
  return 'color:var(--grn)';
}

// Sama ambangnya dengan tpClass() di atas, tapi mengembalikan warna stroke
// polos (tanpa "color:") supaya bisa dipakai langsung sebagai atribut SVG
// stroke=... di probGaugeHtml() (Fase 5).
function tpStrokeColor(p) {
  if (p == null) return 'var(--dim)';
  if (p >= 0.50) return 'var(--red)';
  if (p >= 0.30) return 'var(--amb)';
  if (p >= 0.15) return '#e8d44d';
  return 'var(--grn)';
}

// -- PROBABILITY GAUGE (Fase 5) --------------------------------------------
// Komponen SVG yang sama dengan yang dipakai ui.js untuk odds table & retail
// plan: garis dengan stroke-dashoffset yang di-transition (lihat
// .prob-gauge-fill di base.css) alih-alih lebar <div> statis. dashoffset
// awal SENGAJA penuh (kosong); animateProbGauges() mengisi ke nilai target
// satu tick kemudian lewat requestAnimationFrame supaya transition-nya
// benar-benar kelihatan "mengisi", bukan langsung muncul penuh.
const PROB_GAUGE_LEN = 40;

function probGaugeHtml(prob, color) {
  if (prob == null) return '<span class="dim">\u2014</span>';
  const p = Math.max(0, Math.min(1, prob));
  return `<span style="display:inline-flex;align-items:center;gap:6px;justify-content:flex-end;width:100%">
    <svg class="prob-gauge" width="34" height="10" viewBox="0 0 48 10" aria-hidden="true">
      <path class="prob-gauge-track" d="M4 5 H44" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path class="prob-gauge-fill" data-target="${p}" d="M4 5 H44" stroke="${color}" stroke-width="4" fill="none" stroke-linecap="round" stroke-dasharray="${PROB_GAUGE_LEN}" stroke-dashoffset="${PROB_GAUGE_LEN}"/>
    </svg>
    <b class="mono" style="color:${color}">${(p * 100).toFixed(1)}%</b>
  </span>`;
}

function animateProbGauges(root) {
  const scope = root || document;
  requestAnimationFrame(() => {
    scope.querySelectorAll('.prob-gauge-fill[data-target]').forEach(el => {
      const t = parseFloat(el.dataset.target);
      if (Number.isNaN(t)) return;
      el.style.strokeDashoffset = (PROB_GAUGE_LEN * (1 - t)).toFixed(2);
    });
  });
}

function settleCountdown(settleUtc) {
  if (!settleUtc) return null;
  const diff = new Date(settleUtc).getTime() - Date.now();
  if (diff <= 0) return 'settled';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// The instrument this desk is actually for: BTCUSDT.P (perp), not spot.
// FS.price.price comes from /api/market/price -- a SPOT ticker (Binance
// BTCUSDT spot, falls back to Crypto.com). FS.funding.markPrice comes from
// /api/market/funding -- the actual perp mark price (Binance fapi
// premiumIndex, falls back to Bybit linear). Every price shown on this page
// (entry, SL/TP, barrier table, safe-level table) should be anchored to the
// perp mark, with NOCTUA's spot-anchored barrier curves contributing only
// their *percentage* distances -- not its absolute dollar levels, which are
// computed off Bitstamp BTC-USD and would otherwise carry a small spot/perp
// basis into every printed price. Falls back to the spot ticker only if
// funding data hasn't loaded yet.
function refPrice() {
  const mark = FS.funding?.markPrice;
  if (typeof mark === 'number' && mark > 0) return mark;
  return FS.price?.price ?? null;
}

/* ------------------------------ data load -------------------------------- */

async function loadAll() {
  if (loadInFlight) return;
  loadInFlight = true;
  $('status').textContent = 'loading\u2026';
  try {
    const [price, daily, funding, BGTC] = await Promise.all([
      DataLayer.fetchPrice(),
      DataLayer.fetchDaily(),
      DataLayer.fetchFunding(),
      DataLayer.fetchBGTC(),
    ]);
    FS.price   = price;
    FS.daily   = daily;
    FS.funding = funding;
    FS.BGTC    = BGTC;
    FS.hv20    = daily?.length >= 21 ? DataLayer.computeHV20(daily) : null;

    renderAll();
    $('status').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.error('[futures] load failed', e);
    $('status').textContent = 'load failed \u2014 ' + e.message;
  } finally {
    loadInFlight = false;
    // Fase 4 checklist: jaring pengaman skeleton shimmer -- field yang
    // di-render lewat textContent biasa (panel NOCTUA, Risk Plan) baru
    // lepas class "skel" di sini, satu sapuan, terlepas dari sukses/gagal.
    // Field numerik yang lewat animateValue() di atas (spot/hv20/funding/
    // heroConf) sudah lepas duluan sendiri-sendiri saat animateValue jalan.
    if (typeof clearSkeletons === 'function') clearSkeletons();
  }
}

function renderAll() {
  renderMarket();
  renderNoctua();
  renderSession();
  renderBarrierCurves();
  renderSafeLevels();
  recompute();
}

/* ------------------------------ market card ------------------------------ */

function renderMarket() {
  const spot = FS.price?.price ?? null;   // Binance/Crypto.com spot ticker
  const mark = FS.funding?.markPrice ?? null; // BTCUSDT.P mark price
  const ref  = refPrice();

  animateValue($('spot'), ref, { prefix: '$', decimals: 0 });
  if ($('spotRef')) {
    animateValue($('spotRef'), spot, { prefix: '$', decimals: 0 });
  }
  if ($('basis')) {
    if (mark && mark > 0 && spot) {
      const basis = mark - spot;
      const basisPct = 100 * basis / spot;
      $('basis').textContent =
        `${basis >= 0 ? '+' : ''}$${basis.toFixed(2)} (${basisPct >= 0 ? '+' : ''}${basisPct.toFixed(3)}%)`;
      $('basis').className = Math.abs(basisPct) > 0.15 ? 'warn' : '';
      $('basis').classList.remove('skel');
    } else {
      $('basis').textContent = '\u2014';
      $('basis').className = '';
    }
  }

  animateValue($('hv20'),  FS.hv20?.annualised, { suffix: '%', decimals: 1 });
  animateValue($('hv20d'), FS.hv20?.oneDay,     { suffix: '%', decimals: 2 });
  if (FS.funding) {
    const f = FS.funding;
    const fundingEl = $('funding');
    if (fundingEl) {
      if (!fundingEl.querySelector('.funding-num')) {
        fundingEl.innerHTML = '<span class="funding-num"></span><span class="funding-flag"></span>';
      }
      animateValue(fundingEl.querySelector('.funding-num'), f.ratePct, { suffix: '%', decimals: 4 });
      fundingEl.querySelector('.funding-flag').textContent = ` (${f.flag})`;
      fundingEl.className = f.flag?.includes('extreme') ? 'warn' : '';
    }
  }
  const pAmp = FS.BGTC?.p_vol_amplify ?? (FS.BGTC?.volAmp != null ? FS.BGTC.volAmp / 100 : null);
  animateValue($('volAmp'), pAmp != null ? pAmp * 100 : null, { suffix: '%', decimals: 1 });
  $('volAmp').className    = pAmp > 0.55 ? 'warn' : pAmp <= 0.45 ? 'pos' : '';
}

/* ------------------------------ NOCTUA panel ----------------------------- */

function renderNoctua() {
  const B = FS.BGTC;
  if (!B) { $('noctuaCard').style.opacity = '0.4'; return; }
  $('noctuaCard').style.opacity = '1';

  $('nModel').textContent   = or(B.model);
  $('nHorizon').textContent = B.H_hours ? B.H_hours + 'h' : '\u2014';

  if (B.anchor_utc) {
    $('nAnchor').textContent = B.anchor_utc.slice(0, 16).replace('T', ' ') + ' UTC';
  }
  if (B.settle_utc) {
    const cd = settleCountdown(B.settle_utc);
    const ts = B.settle_utc.slice(0, 16).replace('T', ' ') + ' UTC';
    $('nSettle').textContent = cd ? `${ts}  (${cd})` : ts;
    $('nSettle').className   = cd === 'settled' ? 'dim' : '';
  }

  $('nSigmaW').textContent  = B.sigma_window_pct  != null ? B.sigma_window_pct.toFixed(2)  + '%' : '\u2014';
  $('nSigmaA').textContent  = B.sigma_annualized_pct != null ? B.sigma_annualized_pct.toFixed(1) + '%' : '\u2014';
  $('nTrailingRV').textContent = B.trailing_rv_pct != null ? B.trailing_rv_pct.toFixed(2) + '%' : '\u2014';

  if (B.sigma_window_pct != null && B.trailing_rv_pct != null && B.trailing_rv_pct > 0) {
    const ratio = B.sigma_window_pct / B.trailing_rv_pct;
    $('nVolRatio').textContent = ratio.toFixed(2) + '\u00d7 vs trailing';
    $('nVolRatio').className   = ratio > 1.15 ? 'warn' : ratio < 0.85 ? 'pos' : '';
  }

  if (B.vol_calibration) {
    const c = B.vol_calibration;
    $('nCalib').textContent = c.applied
      ? `applied \u00d7${c.factor.toFixed(3)} (n=${c.n_settled_episodes} episodes, ${c.window_days}d window)`
      : `none \u2014 ${c.note || 'not needed'}`;
    $('nCalib').className = c.applied ? 'warn' : 'pos';
  } else {
    $('nCalib').textContent = '\u2014';
  }
}

/* ------------------------------ session card ----------------------------- */

function renderSession() {
  const s = DataLayer.computeSessionContext();
  const el = $('sessionPhase');
  el.textContent = s.phase;
  el.className = 'verdict ' + ({
    best: 'v-sell', ok: 'v-ok', warn: 'v-caution',
    skip: 'v-stand', neutral: 'v-neutral',
  }[s.tier] || 'v-neutral');
  $('sessionAdvice').textContent = s.advice;
  $('sessionIst').textContent = new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
  }) + ' IST';
}

/* ------------------------------ barrier curves table --------------------- */

function renderBarrierCurves() {
  const B = FS.BGTC;
  const curves = B?.barrier_curves;
  const el = $('barrierBody');
  if (!el) return;
  el.innerHTML = '';

  if (!curves?.up?.length) {
    el.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:10px">barrier curves not in payload \u2014 run NOCTUA first</td></tr>';
    $('barrierCard').style.opacity = '0.5';
    return;
  }
  $('barrierCard').style.opacity = '1';

  // Re-anchor NOCTUA's percentage distances to the BTCUSDT.P mark price
  // instead of trusting the absolute dollar levels in the payload (those
  // are computed off Bitstamp spot and carry the spot/perp basis).
  const ref = refPrice();

  const dnMap = {};
  (curves.dn || []).forEach(c => { dnMap[Math.abs(c.pct)] = c; });

  for (const up of curves.up) {
    const dn = dnMap[up.pct];
    const upPrice = ref ? ref * (1 + up.pct / 100) : up.price;
    const dnPrice = ref && dn ? ref * (1 + dn.pct / 100) : dn?.price;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono" style="color:var(--dim)">${up.pct.toFixed(1)}%</td>
      <td class="mono pos">${upPrice ? '$' + Math.round(upPrice).toLocaleString() : '\u2014'}</td>
      <td>${probGaugeHtml(up.touch_prob, tpStrokeColor(up.touch_prob))}</td>
      <td class="mono neg">${dnPrice ? '$' + Math.round(dnPrice).toLocaleString() : '\u2014'}</td>
      <td>${probGaugeHtml(dn?.touch_prob, tpStrokeColor(dn?.touch_prob))}</td>
    `;
    el.appendChild(tr);
  }

  // Fase 5: isi gauge yang baru saja disisipkan (dashoffset penuh -> target)
  // satu tick setelah DOM terpasang, supaya transition-nya kelihatan.
  animateProbGauges(el);
}

/* ------------------------------ safe levels table ------------------------ */

function renderSafeLevels() {
  const B = FS.BGTC;
  const safe = B?.safe_levels;
  const el = $('safeBody');
  if (!el) return;
  el.innerHTML = '';

  if (!safe?.length) {
    el.innerHTML = '<tr><td colspan="5" class="dim" style="text-align:center;padding:10px">safe levels not in payload</td></tr>';
    $('safeCard').style.opacity = '0.5';
    return;
  }
  $('safeCard').style.opacity = '1';

  // Same re-anchoring as the barrier table: keep NOCTUA's calibrated
  // percentage distances, price them off the BTCUSDT.P mark.
  const ref = refPrice();

  for (const s of safe) {
    const alphaPct = (s.alpha * 100).toFixed(0);
    const callPrice = ref ? ref * (1 + s.call_pct / 100) : s.call_strike;
    const putPrice  = ref ? ref * (1 + s.put_pct  / 100) : s.put_strike;
    const tr = document.createElement('tr');
    const hl = (s.alpha === 0.01 || s.alpha === 0.05) ? 'background:rgba(91,140,255,.06)' : '';
    tr.setAttribute('style', hl);
    tr.innerHTML = `
      <td class="mono" style="color:var(--acc)">${alphaPct}%</td>
      <td class="mono pos">$${Math.round(callPrice).toLocaleString()}</td>
      <td class="mono pos">+${s.call_pct.toFixed(2)}%</td>
      <td class="mono neg">$${Math.round(putPrice).toLocaleString()}</td>
      <td class="mono neg">${s.put_pct.toFixed(2)}%</td>
    `;
    el.appendChild(tr);
  }
}

/* ------------------------------ hero decision card ------------------------ */

function renderHero(decision) {
  const hero = $('heroCard');
  if (!hero || !decision) return;

  hero.className = 'hero ' + decision.verdictClass;

  const icon = decision.verdictClass === 'go'  ? ICONS.check
             : decision.verdictClass === 'cau' ? ICONS.warning
             :                                    ICONS.dash;
  $('heroIcon').innerHTML = icon;
  $('heroVerdict').classList.remove('skel');
  $('heroVerdict').textContent = decision.verdict;
  $('heroSub').textContent = decision.canTrade
    ? `Arah dipilih: ${decision.direction.toUpperCase()} \u00b7 ${decision.reasons.length} sinyal selaras, ${decision.blockers.length} pemblokir`
    : (decision.blockers[0] || 'Mengevaluasi semua sinyal\u2026');

  animateValue($('heroConf'), Math.round(decision.confidence), { suffix: '%', decimals: 0 });
  const bar = $('heroConfBar');
  const color = decision.verdictClass === 'go' ? 'var(--grn)'
              : decision.verdictClass === 'cau' ? 'var(--amb)' : 'var(--red)';
  bar.style.background = color;
  bar.style.width = decision.confidence + '%';

  $('heroReasons').innerHTML = decision.reasons.length
    ? decision.reasons.map(r => `<div class="hero-reason pos"><span class="hero-reason-dot"></span><span>${escape(r)}</span></div>`).join('')
    : '<div style="font-size:11px;color:var(--dim);padding:4px 0">Belum ada.</div>';

  $('heroBlockers').innerHTML = decision.blockers.length
    ? decision.blockers.map(b => `<div class="hero-reason neg"><span class="hero-reason-dot"></span><span>${escape(b)}</span></div>`).join('')
    : '<div style="font-size:11px;color:var(--dim);padding:4px 0">Semua aman.</div>';
}

/* ------------------------------ recompute (risk plan) -------------------- */

function recompute() {
  const price = refPrice();
  if (!price) return;

  const plan = DataLayer.buildFuturesPlan({
    price,                    // BTCUSDT.P mark price (falls back to spot ticker)
    direction:     FS.direction,
    hv20:          FS.hv20,
    BGTC:          FS.BGTC,
    funding:       FS.funding,
    accountEquity: parseFloat($('equityInput').value) || null,
    riskPct:       parseFloat($('riskInput').value) || 1,
    slTouchTarget: parseFloat($('slSlider').value),
    tpTouchTarget: parseFloat($('tpSlider').value),
  });

  renderPlan(plan);

  const session = DataLayer.computeSessionContext();
  const decision = DataLayer.buildFuturesDecision({
    plan, BGTC: FS.BGTC, session, funding: FS.funding, direction: FS.direction,
  });
  renderHero(decision);
}

function renderPlan(plan) {
  const v      = $('planVerdict');
  const warnEl = $('pWarnings');
  warnEl.innerHTML = '';

  if (!plan.ok) {
    v.textContent = plan.reason;
    v.className   = 'verdict v-stand';
    ['pEntry','pSl','pTp','pRR','pSlTouch','pTpTouch','pSize','pRisk']
      .forEach(id => { $(id).textContent = '\u2014'; });
    return;
  }

  v.innerHTML = `${plan.direction.toUpperCase()} plan ready \u2014 ${plan.usedBarrierCurves ? ICONS.check + ' NOCTUA barrier curves' : ICONS.warning + ' HV20 fallback'}`;
  v.className   = 'verdict ' + (plan.direction === 'long' ? 'v-sell' : 'v-caution');

  $('pEntry').textContent   = fmt$(plan.entryPrice);
  $('pSl').textContent      = `${fmt$(plan.stopLoss)}  (${plan.stopDistancePct}%)`;
  $('pTp').textContent      = `${fmt$(plan.takeProfit)}  (${plan.tpDistancePct}%)`;
  $('pRR').textContent      = plan.riskRewardRatio != null ? plan.riskRewardRatio.toFixed(2) + 'x' : '\u2014';
  $('pSlTouch').textContent = plan.slTouchProb != null ? fmtPct(plan.slTouchProb * 100) : 'n/a (HV20 fallback)';
  $('pTpTouch').textContent = plan.tpTouchProb != null ? fmtPct(plan.tpTouchProb * 100) : 'n/a (HV20 fallback)';
  $('pSize').textContent    = (plan.sizeMultiplier * 100).toFixed(0) + '% of normal size';
  $('pRisk').textContent    = plan.riskAmount != null
    ? `${fmt$(plan.riskAmount)} risk / ${fmt$(plan.positionNotional)} notional`
    : 'set account equity to size';

  for (const w of plan.warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    warnEl.appendChild(li);
  }
}

/* ------------------------------ UI wiring --------------------------------- */

function setDirection(dir) {
  FS.direction = dir;
  $('btnLong').classList.toggle('active',  dir === 'long');
  $('btnShort').classList.toggle('active', dir === 'short');
  recompute();
}

let debounce = null;
function onInputChange() {
  clearTimeout(debounce);
  debounce = setTimeout(recompute, 80);
}

document.addEventListener('DOMContentLoaded', () => {
  $('btnRefresh').addEventListener('click', loadAll);
  $('btnLong').addEventListener('click',  () => setDirection('long'));
  $('btnShort').addEventListener('click', () => setDirection('short'));
  $('equityInput').addEventListener('input', onInputChange);
  $('riskInput').addEventListener('input',   onInputChange);
  $('slSlider').addEventListener('input', () => {
    $('slVal').textContent = Math.round($('slSlider').value * 100) + '%';
    onInputChange();
  });
  $('tpSlider').addEventListener('input', () => {
    $('tpVal').textContent = Math.round($('tpSlider').value * 100) + '%';
    onInputChange();
  });

  loadAll();
  setInterval(loadAll, 5 * 60_000);   // auto-refresh 5 menit
  setInterval(renderSession, 60_000); // update IST phase tiap menit
});
