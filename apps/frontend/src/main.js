/**
 * main.js (v4)
 * =====================================================================
 * Parallel-fetching orchestrator. Builds the master Decision object
 * that drives the hero card. Slider changes trigger local recomputation
 * only (no API calls).
 */

let state = {
  price: null, hourly: null, daily: null, fg: null, BGTC: null, news: null,
  options: null, ranger: null, sentiment: null, hv20: null, atmInfo: null, noctuaExport: null,
  regime: null, retailPlan: null, funding: null, session: null, decision: null,
};

let refreshInFlight = false;

async function refreshAll() {
  if (refreshInFlight) { console.warn('[v4] refreshAll skipped \u2014 already running'); return; }
  refreshInFlight = true;
  try {
    await doRefreshAll();
  } finally {
    refreshInFlight = false;
  }
}

async function fetchNoctuaExport() {
  try {
    const r = await fetch('/api/noctua/data', { signal: AbortSignal.timeout(7000), cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    console.warn('[NOCTUA export] metadata unavailable:', e.message);
    return null;
  }
}

function renderNoctuaExport(meta) {
  const status = document.getElementById('noctuaExportStatus');
  const pqMeta = document.getElementById('noctuaParquetMeta');
  const csvMeta = document.getElementById('noctuaCsvMeta');
  const updated = document.getElementById('noctuaExportUpdated');
  const pqBtn = document.getElementById('noctuaParquetBtn');
  const csvBtn = document.getElementById('noctuaCsvBtn');
  if (!status || !pqMeta || !csvMeta) return;

  const fmtSize = bytes => {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  };
  const fmtDate = iso => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime())
      ? d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
      : '—';
  };
  const enable = (el, href) => {
    if (!el || !href) return;
    el.href = href;
    el.classList.add('ready');
  };

  const count = [meta?.parquet, meta?.csv].filter(Boolean).length;
  if (!meta || !count) {
    status.className = 'pill-sm err';
    status.textContent = 'R2 OFFLINE';
    pqMeta.textContent = 'Belum tersedia';
    csvMeta.textContent = 'Belum tersedia';
    if (updated) updated.textContent = 'Export belum tersedia';
    return;
  }

  status.className = count === 2 ? 'pill-sm ok' : 'pill-sm warn';
  status.textContent = count === 2 ? 'R2 READY' : 'R2 PARTIAL';

  if (meta.parquet) {
    pqMeta.textContent = fmtSize(meta.parquet.size_bytes) + ' · ' + fmtDate(meta.parquet.uploaded);
    enable(pqBtn, meta.download_parquet || '/api/noctua/download?format=parquet');
  } else pqMeta.textContent = 'Belum tersedia';

  if (meta.csv) {
    csvMeta.textContent = fmtSize(meta.csv.size_bytes) + ' · ' + fmtDate(meta.csv.uploaded);
    enable(csvBtn, meta.download_csv || '/api/noctua/download?format=csv');
  } else csvMeta.textContent = 'Belum tersedia';

  const latest = [meta.parquet?.uploaded, meta.csv?.uploaded].filter(Boolean).sort().pop();
  if (updated) updated.textContent = latest ? 'Update terakhir · ' + fmtDate(latest) : 'Metadata tersedia';
}

async function doRefreshAll() {
  console.log('[v4] refreshAll start');
  UI.updateClock();

  const [price, hourly, daily, fg, options, BGTC, funding, noctuaExport] = await Promise.all([
    DataLayer.fetchPrice().catch(e => (console.error('price fail', e), null)),
    DataLayer.fetchHourly().catch(e => (console.error('hourly fail', e), null)),
    DataLayer.fetchDaily().catch(e => (console.error('daily fail', e), null)),
    DataLayer.fetchFearGreed().catch(e => (console.error('fg fail', e), null)),
    DataLayer.fetchOptions().catch(e => (console.error('options fail', e), null)),
    DataLayer.fetchBGTC().catch(e => (console.error('BGTC fail', e), null)),
    DataLayer.fetchFunding().catch(e => (console.error('funding fail', e), null)),
    fetchNoctuaExport(),
  ]);
  Object.assign(state, { price, hourly, daily, fg, options, BGTC, funding, noctuaExport });
  renderNoctuaExport(noctuaExport);

  state.news = await DataLayer.fetchNewsSentiment().catch(e => (console.error('news fail', e), null));

  if (state.daily?.length >= 21) state.hv20 = DataLayer.computeHV20(state.daily);
  if (state.options && state.price) state.atmInfo = DataLayer.findAtmIv(state.options, state.price.price);
  if (state.atmInfo && state.hv20) state.regime = DataLayer.classifyRegime(state.atmInfo.atmIv, state.hv20.annualised);
  state.session = DataLayer.computeSessionContext();
  if (state.daily?.length && state.price) state.ranger = DataLayer.computeRanger(state.daily, state.fg, state.regime?.ratio);
  state.sentiment = DataLayer.computeSentiment(state.news, state.BGTC, state.fg, state.regime);

  if (state.price && state.options && state.atmInfo && state.hv20 && state.regime && state.BGTC) {
    state.retailPlan = DataLayer.buildRetailPlan({
      price:          state.price.price,
      options:        state.options,
      atmInfo:        state.atmInfo,
      hv20:           state.hv20,
      BGTCUpside:     state.BGTC.upside,
      regime:         state.regime,
      shortLots:      parseInt(document.getElementById('rpLots')?.value) || 60,
      touchThreshold: parseFloat(document.getElementById('rpTouch')?.value || '0.10'),
      safetyFactor:   parseFloat(document.getElementById('rpSafety')?.value || '1.15'),
    });
  }

  state.decision = DataLayer.buildDecision({
    price: state.price, hv20: state.hv20, regime: state.regime, BGTC: state.BGTC,
    retailPlan: state.retailPlan, session: state.session, funding: state.funding,
    sentiment: state.sentiment,
  });

  UI.updateHero(state.decision);
  UI.updatePulseStrip(state);
  UI.updateBGTCBadge(state.BGTC);
  UI.updateSessionRibbon(state.session);
  UI.updateRegimeDial(state.regime, state.hv20, state.atmInfo);
  UI.updateRetailPlan(state.retailPlan, state.price?.price, state.hv20, state.regime, state.atmInfo);
  UI.updateOddsTable(DataLayer.nextDayMoveOdds(state.regime?.ratio), state.hv20, state.price?.price);
  UI.updateBGTCCard(state.BGTC);

  if (state.ranger && state.price) {
    UI.updateRanger(state.ranger, state.price.price);
    const { callStrike, putStrike } = UI.computeStrikes(state.price.price, state.ranger, state.BGTC?.upside || 50);
    UI.renderRangeVisual(state.price.price, putStrike, callStrike);
  }

  if (state.hourly?.length) Charts.renderPriceChart(state.hourly);

  UI.updateSignals(state);
  UI.updateNewsFeed(state.news);

  // Fase 4 checklist (checklist-upgrade-pro-btc-desk.md): jaring pengaman
  // skeleton shimmer. Sebagian besar field sudah berhenti berkedip sendiri-
  // sendiri lewat set()/setH()/animateValue() di ui.js begitu menerima nilai
  // pertamanya, tapi field yang datanya tetap null pada load pertama (mis.
  // API sumbernya gagal) tidak akan pernah memanggil salah satu dari itu --
  // clearSkeletons() di sini melepas sisa class "skel" apa pun begitu satu
  // putaran refresh selesai, supaya tidak ada placeholder yang shimmer
  // selamanya. Aman dipanggil berulang (tidak melakukan apa-apa kalau
  // sudah tidak ada elemen ".skel" tersisa).
  if (typeof clearSkeletons === 'function') clearSkeletons();

  console.log('[v4] refreshAll done', {
    price: state.price?.price,
    BGTC: state.BGTC ? `${state.BGTC.upside}/${state.BGTC.volAmp} (${state.BGTC.freshness})` : 'null',
    hv20: state.hv20?.annualised?.toFixed(1),
    regime: state.regime?.label,
    verdict: state.decision?.verdict,
  });
}

async function refreshPrice() {
  const price = await DataLayer.fetchPrice();
  if (!price) return;
  state.price = price;
  UI.updatePulseStrip(state);
  UI.updateClock();
  if (state.ranger) {
    const { callStrike, putStrike } = UI.computeStrikes(price.price, state.ranger, state.BGTC?.upside || 50);
    UI.renderRangeVisual(price.price, putStrike, callStrike);
  }
}

let sliderDebounce = null;
function onRetailSliderChange() {
  clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(doRetailSliderChange, 80);
}

function doRetailSliderChange() {
  if (!state.price || !state.options || !state.atmInfo || !state.hv20 || !state.regime || !state.BGTC) return;
  state.retailPlan = DataLayer.buildRetailPlan({
    price:          state.price.price,
    options:        state.options,
    atmInfo:        state.atmInfo,
    hv20:           state.hv20,
    BGTCUpside:     state.BGTC.upside,
    regime:         state.regime,
    shortLots:      parseInt(document.getElementById('rpLots')?.value) || 60,
    touchThreshold: parseFloat(document.getElementById('rpTouch')?.value || '0.10'),
    safetyFactor:   parseFloat(document.getElementById('rpSafety')?.value || '1.15'),
  });
  state.decision = DataLayer.buildDecision({
    price: state.price, hv20: state.hv20, regime: state.regime, BGTC: state.BGTC,
    retailPlan: state.retailPlan, session: state.session, funding: state.funding,
    sentiment: state.sentiment,
  });
  UI.updateHero(state.decision);
  UI.updateRetailPlan(state.retailPlan, state.price.price, state.hv20, state.regime, state.atmInfo);
}

function startLoops() {
  setInterval(refreshPrice, 60_000);
  setInterval(refreshAll,   30 * 60_000);
  setInterval(UI.updateClock, 10_000);
}

(async function boot() {
  console.log('[v4] Booting BGTC/HV20 Retail desk\u2026');
  UI.updateClock();
  await refreshAll();
  startLoops();
  console.log('[v4] Ready \u00b7 price 60s \u00b7 full 30m');
})();