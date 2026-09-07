/* =========================================================================
   BTC Futures Risk Desk — src/futures.js (v1)
   Wires DataLayer.buildFuturesPlan() (see src/data.js) to a standalone page
   for BTCUSDT.P perpetual futures.

   Unlike src/options.js, this reuses DataLayer (loaded via data.js) rather
   than re-implementing its own fetchers, since the futures planner needs
   the exact same BGTC/NOCTUA payload (barrier_curves, p_vol_amplify) that
   the options desk gets from the Worker -- no reason to duplicate that
   fetch logic. See docs/TRADE_FLOW.md §8 for the full explanation of what's
   reused from the options pipeline and what isn't.
   ========================================================================= */
'use strict';

const FS = {
  price: null, daily: null, hv20: null, funding: null, BGTC: null,
  direction: 'long',
};

const $ = (id) => document.getElementById(id);
const fmt$ = (v) => v == null ? '—' : '$' + Math.round(v).toLocaleString();
const fmtPct = (v, d = 1) => v == null ? '—' : (v * 100).toFixed(d) + '%';

/* ------------------------------ data load -------------------------------- */

async function loadAll() {
  $('status').textContent = 'loading…';
  try {
    const [price, daily, funding, BGTC] = await Promise.all([
      DataLayer.fetchPrice(),
      DataLayer.fetchDaily(),
      DataLayer.fetchFunding(),
      DataLayer.fetchBGTC(),
    ]);
    FS.price = price;
    FS.daily = daily;
    FS.funding = funding;
    FS.BGTC = BGTC;
    FS.hv20 = daily?.length >= 21 ? DataLayer.computeHV20(daily) : null;
    renderMarket();
    recompute();
    $('status').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.error('[futures] load failed', e);
    $('status').textContent = 'load failed — ' + e.message;
  }
}

function renderMarket() {
  $('spot').textContent = fmt$(FS.price?.price);
  $('hv20').textContent = FS.hv20 ? FS.hv20.annualised.toFixed(1) + '%' : '—';
  $('hv20d').textContent = FS.hv20 ? FS.hv20.oneDay.toFixed(2) + '%' : '—';
  $('funding').textContent = FS.funding
    ? `${FS.funding.ratePct.toFixed(4)}% (${FS.funding.flag})`
    : '—';
  const pAmp = FS.BGTC?.p_vol_amplify ?? (FS.BGTC?.volAmp != null ? FS.BGTC.volAmp / 100 : null);
  $('volAmp').textContent = pAmp != null ? (pAmp * 100).toFixed(1) + '%' : 'n/a';
  const hasBarrier = !!(FS.BGTC?.barrier_curves?.up?.length && FS.BGTC?.barrier_curves?.dn?.length);
  $('hasBarrier').textContent = hasBarrier ? 'yes' : 'no (falling back to HV20)';
  $('hasBarrier').className = hasBarrier ? 'pos' : 'warn';
}

/* ------------------------------ recompute --------------------------------- */

function recompute() {
  if (!FS.price?.price) return;

  const plan = DataLayer.buildFuturesPlan({
    price: FS.price.price,
    direction: FS.direction,
    hv20: FS.hv20,
    BGTC: FS.BGTC,
    funding: FS.funding,
    accountEquity: parseFloat($('equityInput').value) || null,
    riskPct: parseFloat($('riskInput').value) || 1,
    slTouchTarget: parseFloat($('slSlider').value),
    tpTouchTarget: parseFloat($('tpSlider').value),
  });

  renderPlan(plan);
}

function renderPlan(plan) {
  const v = $('planVerdict');
  const warnEl = $('pWarnings');
  warnEl.innerHTML = '';

  if (!plan.ok) {
    v.textContent = plan.reason;
    v.className = 'verdict v-stand';
    $('pEntry').textContent = $('pSl').textContent = $('pTp').textContent = '—';
    $('pRR').textContent = $('pSlTouch').textContent = $('pTpTouch').textContent = '—';
    $('pSize').textContent = $('pRisk').textContent = '—';
    return;
  }

  v.textContent = `${plan.direction.toUpperCase()} plan ready —${plan.usedBarrierCurves ? ' NOCTUA barrier curves' : ' HV20 fallback'}`;
  v.className = 'verdict ' + (plan.direction === 'long' ? 'v-sell' : 'v-caution');

  $('pEntry').textContent = fmt$(plan.entryPrice);
  $('pSl').textContent = `${fmt$(plan.stopLoss)}  (${plan.stopDistancePct}%)`;
  $('pTp').textContent = `${fmt$(plan.takeProfit)}  (${plan.tpDistancePct}%)`;
  $('pRR').textContent = plan.riskRewardRatio != null ? plan.riskRewardRatio.toFixed(2) + '×' : '—';
  $('pSlTouch').textContent = plan.slTouchProb != null ? fmtPct(plan.slTouchProb) : 'n/a (HV20 fallback)';
  $('pTpTouch').textContent = plan.tpTouchProb != null ? fmtPct(plan.tpTouchProb) : 'n/a (HV20 fallback)';
  $('pSize').textContent = (plan.sizeMultiplier * 100).toFixed(0) + '% of normal size';
  $('pRisk').textContent = plan.riskAmount != null
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
  $('btnLong').classList.toggle('active', dir === 'long');
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
  $('btnLong').addEventListener('click', () => setDirection('long'));
  $('btnShort').addEventListener('click', () => setDirection('short'));
  $('equityInput').addEventListener('input', onInputChange);
  $('riskInput').addEventListener('input', onInputChange);
  $('slSlider').addEventListener('input', () => { $('slVal').textContent = Math.round($('slSlider').value * 100) + '%'; onInputChange(); });
  $('tpSlider').addEventListener('input', () => { $('tpVal').textContent = Math.round($('tpSlider').value * 100) + '%'; onInputChange(); });

  loadAll();
  setInterval(loadAll, 5 * 60_000);   // 5-min auto refresh
});
