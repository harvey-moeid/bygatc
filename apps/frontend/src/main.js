/**
 * main.js (v4)
 * =====================================================================
 * Parallel-fetching orchestrator. Builds the master Decision object
 * that drives the hero card. Slider changes trigger local recomputation
 * only (no API calls).
 */

let state = {
  price: null, hourly: null, daily: null, fg: null, kronos: null, news: null,
  options: null, ranger: null, sentiment: null, hv20: null, atmInfo: null,
  regime: null, retailPlan: null, funding: null, session: null, decision: null,
};

// v4.1: in-flight guard. The 30-min interval and a slow proxy chain (4 proxies
// × 9 s timeouts on several endpoints) can overlap; overlapping runs double the
// API spend and race each other writing `state`. Re-entrant calls now no-op.
let refreshInFlight = false;

async function refreshAll() {
  if (refreshInFlight) { console.warn('[v4] refreshAll skipped — already running'); return; }
  refreshInFlight = true;
  try {
    await doRefreshAll();
  } finally {
    refreshInFlight = false;
  }
}

async function doRefreshAll() {
  console.log('[v4] refreshAll start');
  UI.updateClock();

  // ─── PARALLEL FETCH (all independent endpoints at once) ──────────────
  // Price + candles + FG + options + Kronos + funding all run concurrently.
  const [price, hourly, daily, fg, options, kronos, funding] = await Promise.all([
    DataLayer.fetchPrice().catch(e => (console.error('price fail', e), null)),
    DataLayer.fetchHourly().catch(e => (console.error('hourly fail', e), null)),
    DataLayer.fetchDaily().catch(e => (console.error('daily fail', e), null)),
    DataLayer.fetchFearGreed().catch(e => (console.error('fg fail', e), null)),
    DataLayer.fetchOptions().catch(e => (console.error('options fail', e), null)),
    DataLayer.fetchKronos().catch(e => (console.error('kronos fail', e), null)),
    DataLayer.fetchFunding().catch(e => (console.error('funding fail', e), null)),
  ]);
  Object.assign(state, { price, hourly, daily, fg, options, kronos, funding });

  // News fetched after (slower, has CORS-proxy dependency)
  state.news = await DataLayer.fetchNewsSentiment().catch(e => (console.error('news fail', e), null));

  // ─── DERIVED COMPUTATIONS ────────────────────────────────────────────
  if (state.daily?.length >= 21) state.hv20 = DataLayer.computeHV20(state.daily);
  if (state.options && state.price) state.atmInfo = DataLayer.findAtmIv(state.options, state.price.price);
  if (state.atmInfo && state.hv20) state.regime = DataLayer.classifyRegime(state.atmInfo.atmIv, state.hv20.annualised);
  state.session = DataLayer.computeSessionContext();
  if (state.daily?.length && state.price) state.ranger = DataLayer.computeRanger(state.daily, state.fg, state.regime?.ratio);
  state.sentiment = DataLayer.computeSentiment(state.news, state.kronos, state.fg, state.regime);

  // Retail plan
  if (state.price && state.options && state.atmInfo && state.hv20 && state.regime && state.kronos) {
    state.retailPlan = DataLayer.buildRetailPlan({
      price:          state.price.price,
      options:        state.options,
      atmInfo:        state.atmInfo,
      hv20:           state.hv20,
      kronosUpside:   state.kronos.upside,
      regime:         state.regime,
      shortLots:      parseInt(document.getElementById('rpLots')?.value) || 60,
      touchThreshold: parseFloat(document.getElementById('rpTouch')?.value || '0.10'),
      safetyFactor:   parseFloat(document.getElementById('rpSafety')?.value || '1.15'),
    });
  }

  // Master decision
  state.decision = DataLayer.buildDecision({
    price: state.price, hv20: state.hv20, regime: state.regime, kronos: state.kronos,
    retailPlan: state.retailPlan, session: state.session, funding: state.funding,
    sentiment: state.sentiment,
  });

  // ─── UI UPDATES ──────────────────────────────────────────────────────
  UI.updateHero(state.decision);
  UI.updatePulseStrip(state);
  UI.updateKronosBadge(state.kronos);
  UI.updateSessionRibbon(state.session);
  UI.updateRegimeDial(state.regime, state.hv20, state.atmInfo);
  UI.updateRetailPlan(state.retailPlan, state.price?.price, state.hv20, state.regime, state.atmInfo);
  UI.updateOddsTable(DataLayer.nextDayMoveOdds(state.regime?.ratio), state.hv20, state.price?.price);
  UI.updateKronosCard(state.kronos);

  if (state.ranger && state.price) {
    UI.updateRanger(state.ranger, state.price.price);
    const { callStrike, putStrike } = UI.computeStrikes(state.price.price, state.ranger, state.kronos?.upside || 50);
    UI.renderRangeVisual(state.price.price, putStrike, callStrike);
  }

  if (state.hourly?.length) Charts.renderPriceChart(state.hourly);

  UI.updateSignals(state);
  UI.updateNewsFeed(state.news);
  UI.updateRateLimits(RateLimit.getStats());

  console.log('[v4] refreshAll done', {
    price: state.price?.price,
    kronos: state.kronos ? `${state.kronos.upside}/${state.kronos.volAmp} (${state.kronos.freshness})` : 'null',
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
  UI.updateRateLimits(RateLimit.getStats());
  if (state.ranger) {
    const { callStrike, putStrike } = UI.computeStrikes(price.price, state.ranger, state.kronos?.upside || 50);
    UI.renderRangeVisual(price.price, putStrike, callStrike);
  }
}

// Triggered by retail-panel slider inputs — recomputes locally, no network.
// v4.1: debounced 80 ms — `input` fires on every pixel of a drag and the full
// plan + decision rebuild was running hundreds of times per slider gesture.
let sliderDebounce = null;
function onRetailSliderChange() {
  clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(doRetailSliderChange, 80);
}

function doRetailSliderChange() {
  if (!state.price || !state.options || !state.atmInfo || !state.hv20 || !state.regime || !state.kronos) return;
  state.retailPlan = DataLayer.buildRetailPlan({
    price:          state.price.price,
    options:        state.options,
    atmInfo:        state.atmInfo,
    hv20:           state.hv20,
    kronosUpside:   state.kronos.upside,
    regime:         state.regime,
    shortLots:      parseInt(document.getElementById('rpLots')?.value) || 60,
    touchThreshold: parseFloat(document.getElementById('rpTouch')?.value || '0.10'),
    safetyFactor:   parseFloat(document.getElementById('rpSafety')?.value || '1.15'),
  });
  // Rebuild decision with new plan
  state.decision = DataLayer.buildDecision({
    price: state.price, hv20: state.hv20, regime: state.regime, kronos: state.kronos,
    retailPlan: state.retailPlan, session: state.session, funding: state.funding,
    sentiment: state.sentiment,
  });
  UI.updateHero(state.decision);
  UI.updateRetailPlan(state.retailPlan, state.price.price, state.hv20, state.regime, state.atmInfo);
}

function startLoops() {
  setInterval(refreshPrice, 60_000);            // price every 60s
  setInterval(refreshAll,   30 * 60_000);       // full every 30m
  setInterval(UI.updateClock, 10_000);
}

(async function boot() {
  console.log('[v4] Booting KRONOS/HV20 Retail desk…');
  UI.updateClock();
  await refreshAll();
  startLoops();
  console.log('[v4] Ready · price 60s · full 30m');
})();
