/* =========================================================================
   BTC Option-Selling Desk — src/options.js (v1)
   One Deribit call for the full chain; IV inverted locally via Black-76
   bisection; analytic deltas; delta-targeted short-strangle builder with a
   Delta-Exchange margin heuristic; regime gate from Kronos + F&G + funding.
   Free resources only. No keys. CORS-clean endpoints:
     - api.deribit.com (Access-Control-Allow-Origin: *)
     - api.binance.com / fapi.binance.com
     - local ./data/*.json snapshots (committed by GH Actions)
   ========================================================================= */
'use strict';

/* ------------------------------ math: Black-76 -------------------------- */
function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 — |err| < 7.5e-8, plenty for IV work
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
  // bisection: robust, monotone in sigma; 60 iters ≈ 1e-9 precision
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
  dvol: null, dvolPrev: null, shock: null,   // Buyer's Radar inputs
  kronos: null, fng: null,
  chainByExpiry: new Map(),   // expiryMs -> [{strike, callMark, putMark, callOi, putOi, iv..., delta...}]
  selectedExpiry: null,
};

const $ = id => document.getElementById(id);
const fmt$ = v => v == null ? '—' : '$' + Math.round(v).toLocaleString();
const fmtPct = (v, d = 1) => v == null ? '—' : (v * 100).toFixed(d) + '%';

/* ------------------------------ fetchers --------------------------------- */
async function jget(url, opts) {
  const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts));
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}

async function fetchChain() {
  // Single call: every BTC option's mark, OI, underlying — we solve IV ourselves.
  const j = await jget('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
  const rows = j.result || [];
  const byExp = new Map();
  let spot = null;
  for (const r of rows) {
    // instrument_name: BTC-27JUN26-60000-C
    const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(r.instrument_name);
    if (!m) continue;
    const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    const expMs = Date.UTC(2000 + +m[3], months[m[2]], +m[1], 8, 0, 0); // Deribit expiry 08:00 UTC
    if (expMs < Date.now() + 30 * 60_000) continue;                      // skip expiring <30m
    const strike = +m[4];
    if (r.underlying_price > 0) spot = r.underlying_price;
    if (!byExp.has(expMs)) byExp.set(expMs, new Map());
    const chain = byExp.get(expMs);
    if (!chain.has(strike)) chain.set(strike, { strike });
    const row = chain.get(strike);
    const markUsd = (r.mark_price || 0) * (r.underlying_price || 0);     // BTC-denominated mark -> USD
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
  // 121 daily candles: enough for HV20, MA100, 90d drawdown and RSI(14) in one call.
  const k = await jget('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=121');
  const allCloses = k.map(c => +c[4]);
  const closes = allCloses.slice(-22);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  S.hv20 = Math.sqrt(varr) * Math.sqrt(365);

  // Shock-day detector (Buyer's Radar): |last completed daily move| > 2.5x trailing daily vol.
  // Backtested post-ETF: 5d straddle win 43.2% vs 35.0% base at real DVOL cost (p=0.044, n=37).
  const prior = rets.slice(0, -1);                       // exclude the most recent return
  const pm = prior.reduce((a, b) => a + b, 0) / prior.length;
  const pv = prior.reduce((a, b) => a + (b - pm) ** 2, 0) / (prior.length - 1);
  const dailySd = Math.sqrt(pv);
  const lastRet = rets[rets.length - 1];
  S.shock = { on: Math.abs(lastRet) > 2.5 * dailySd, lastRet, ratio: dailySd > 0 ? Math.abs(lastRet) / dailySd : 0 };

  // Seller's Compass inputs (SELLER_DIRECTIONAL_ALPHA.md): trend, drawdown, RSI(14).
  if (allCloses.length >= 101) {
    const last = allCloses[allCloses.length - 1];
    const ma100 = allCloses.slice(-100).reduce((a, b) => a + b, 0) / 100;
    const hi90 = Math.max(...allCloses.slice(-90));
    // Wilder-smoothed RSI(14) over the full window
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
  // 540 x 8h records = 180 days: 7d-avg daily funding + its percentile in the window.
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
  // Deribit DVOL index (BTC 30d implied vol) — free public endpoint, last ~8 days for trend.
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
  // GH-Actions snapshots; tolerate absence (e.g. fresh clone).
  try { S.kronos = await jget('data/kronos.json?_=' + Date.now()); } catch (_) {}
  try {
    const local = await jget('data/kronos_local.json?_=' + Date.now());
    // prefer local model output when fresher
    if (local && (!S.kronos || (local._updatedMs || 0) > (S.kronos._updatedMs || 0))) S.kronos = local;
  } catch (_) {}
  try { S.fng = await jget('data/fg.json?_=' + Date.now()); } catch (_) {}
  try { S.finbert = await jget('data/sentiment.json?_=' + Date.now()); } catch (_) {}
  try { S.seas = await jget('data/vol_seasonality.json?_=' + Date.now()); } catch (_) {}
}

/* ------------------------- trading clock (seasonality) -------------------- */
// 2015-2026 study: yearly RV compressed ~69%->48% post-ETF; quietest UTC hours
// 03-05 & 09-11; loudest 13-16 (US macro prints + cash open); weekends run at
// ~64% of weekday vol. See BTC_VOL_RESEARCH.md for the full evidence.
function renderClock() {
  const el = document.getElementById('clockNow');
  if (!el) return;
  const s = S.seas;
  const now = new Date();
  const h = now.getUTCHours(), dow = (now.getUTCDay() + 6) % 7; // Mon=0
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  if (!s || !s.hourVolBpsPostEtf) {
    el.textContent = 'Seasonality snapshot not available — run the fetch-data workflow once.';
    return;
  }
  const hv = s.hourVolBpsPostEtf;
  const vals = Object.keys(hv).map(k => hv[k]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const cur = hv[String(h)];
  const quiet = (s.quietHoursUtc || []).includes(h);
  const loud  = (s.loudHoursUtc  || []).includes(h);
  const wknd  = dow >= 5;
  const regime = loud ? ['LOUD HOUR', 'neg'] : quiet ? ['QUIET HOUR', 'pos'] : ['NORMAL HOUR', 'warn'];
  el.innerHTML =
    `It is <b>${String(h).padStart(2,'0')}:00 UTC, ${days[dow]}</b> — historically a ` +
    `<b class="${regime[1]}">${regime[0]}</b> (${cur} bps/h vs range ${min}–${max})` +
    (wknd ? ` · <b class="pos">WEEKEND</b>: vol runs at ~${Math.round((s.weekendVolRatio || 0.64) * 100)}% of weekday — theta harvest territory` : '');

  // 24 mini bars
  const bars = document.getElementById('clockBars');
  if (bars) {
    bars.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const v = hv[String(i)] ?? min;
      const pct = Math.max(8, Math.round((v - min) / (max - min) * 100));
      const d = document.createElement('div');
      d.style.cssText = `flex:1;height:${pct}%;border-radius:2px 2px 0 0;` +
        `background:${i === h ? '#5b8cff' : (s.loudHoursUtc || []).includes(i) ? 'rgba(248,81,73,.7)' : (s.quietHoursUtc || []).includes(i) ? 'rgba(63,185,80,.7)' : 'rgba(139,148,158,.45)'}`;
      d.title = `${String(i).padStart(2,'0')}:00 UTC — ${v} bps/h`;
      bars.appendChild(d);
    }
  }

  const adv = document.getElementById('clockAdvice');
  if (adv) {
    const mon = now.getUTCMonth() + 1;
    const mrv = s.monthRv ? s.monthRv[String(mon)] : null;
    const mAvg = s.monthRv ? Object.values(s.monthRv).reduce((a, b) => a + b, 0) / 12 : null;
    const lines = [];
    if (loud)  lines.push('🔴 <b>US-session power hours (13–16 UTC).</b> This is where CPI/NFP prints and the NYSE open land — the loudest 4 hours of the day. <b>Straddle BUYERS</b> want positions on before this window on macro days; sellers should already be hedged or flat.');
    if (quiet) lines.push('🟢 <b>Statistically the sleepiest stretch of the day.</b> If the Risk Gate above is GREEN, this is when short-premium entries historically suffer the least adverse movement.');
    if (!loud && !quiet) lines.push('🟡 Mid-pack hour — no statistical edge either way; let the Risk Gate decide.');
    if (dow === 4) lines.push('📅 <b>Friday:</b> the classic income window opens after US close (~21:00 UTC) — weekends realize only ~64% of weekday vol, the one structural overpay in BTC options. Sell only with GREEN gate + defined exits; thin weekend books can still gap.');
    if (dow === 3) lines.push('📅 <b>Thursday:</b> historically the loudest weekday on daily closes — favors straddle <i>buyers</i> when IV is cheap.');
    if (mrv != null && mAvg != null) {
      lines.push(`📆 This month historically runs <b>${mrv}%</b> annualized vs ${mAvg.toFixed(0)}% average — ${mrv < mAvg * 0.9 ? 'a calm-season tilt (theta-friendly)' : mrv > mAvg * 1.1 ? 'a storm-season tilt (respect tails, favor defined risk)' : 'about average'}.`);
    }
    if (s.clustering) lines.push(`🔁 Vol clusters: after a quiet day there's a ${Math.round(s.clustering.pQuietAfterQuiet * 100)}% chance the next day is quiet too — regimes persist, so don't fight yesterday's tape.`);
    lines.push(`<span style="color:var(--dim)">Post-ETF era fact: realized vol compressed from ~69% (2020–23) to ~48% — BTC is calming as ETF money deepens liquidity, but it's still ~3× stock-index vol. Full study: BTC_VOL_RESEARCH.md.</span>`);
    adv.innerHTML = lines.map(l => '• ' + l).join('<br>');
  }
}

/* --------------------------- chain enrichment ---------------------------- */
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

/* --------------------------- strangle builder ---------------------------- */
function pickLeg(rows, targetAbsDelta, side) {
  // side 'P': delta in (-1,0); 'C': delta in (0,1). Pick OTM leg nearest target.
  let best = null, bestErr = Infinity;
  for (const r of rows) {
    const d = side === 'P' ? r.putDelta : r.callDelta;
    const mark = side === 'P' ? r.putMark : r.callMark;
    if (d == null || mark == null || mark <= 0) continue;
    if (side === 'P' && r.strike >= S.spot) continue;   // OTM only
    if (side === 'C' && r.strike <= S.spot) continue;
    const err = Math.abs(Math.abs(d) - targetAbsDelta);
    if (err < bestErr) { bestErr = err; best = r; }
  }
  return best;
}

function deltaExMarginPerLeg(strike, premiumUsd, isPut) {
  // Delta Exchange short-option heuristic (documented in footer; VERIFY in
  // their calculator): max(15% * spot - OTM distance, 7.5% * spot) + premium.
  const spot = S.spot;
  const otm = isPut ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  return Math.max(0.15 * spot - otm, 0.075 * spot) + premiumUsd;
}

/* ------------------------------ risk gate -------------------------------- */
function computeGate(atm) {
  const why = [];
  let score = 0; // positive = favorable to sell premium

  const ivhv = (atm && S.hv20) ? atm / S.hv20 : null;
  if (ivhv != null) {
    if (ivhv >= 1.25) { score += 2; why.push(`IV/HV ${ivhv.toFixed(2)} — fat premium vs realized (edge to sellers)`); }
    else if (ivhv >= 1.05) { score += 1; why.push(`IV/HV ${ivhv.toFixed(2)} — modest vol-risk premium`); }
    else { score -= 2; why.push(`IV/HV ${ivhv.toFixed(2)} — options are CHEAP vs realized; selling has no statistical edge`); }
  }

  const volAmp = S.kronos?.volAmp;
  if (volAmp != null) {
    if (volAmp >= 80) { score -= 2; why.push(`Kronos vol-amplification ${volAmp}% — model expects realized vol to EXPAND; short gamma is dangerous`); }
    else if (volAmp >= 60) { score -= 1; why.push(`Kronos vol-amplification ${volAmp}% — elevated expansion risk`); }
    else { score += 1; why.push(`Kronos vol-amplification ${volAmp}% — vol expected calm`); }
  }

  const up = S.kronos?.upside;
  if (up != null && (up >= 70 || up <= 30)) {
    score -= 1; why.push(`Kronos directional skew (upside ${up}%) — delta-neutral strangles fight a directional model`);
  }

  const fv = S.fng?.value;
  if (fv != null) {
    if (fv <= 15 || fv >= 88) { score -= 1; why.push(`Fear & Greed ${fv} — extreme readings precede outsized moves; widen strikes or cut size`); }
    else { score += 1; why.push(`Fear & Greed ${fv} — mid-regime, mean-reversion friendly`); }
  }

  const fb = S.finbert;
  if (fb && fb.score != null && Math.abs(fb.score) > 0.35) {
    score -= 1;
    why.push(`FinBERT news sentiment ${fb.score > 0 ? '+' : ''}${fb.score} (${fb.label}, ${fb.n} headlines) — strong one-sided news flow fuels trends, the enemy of strangles`);
  } else if (fb && fb.score != null) {
    why.push(`FinBERT news sentiment ${fb.score > 0 ? '+' : ''}${fb.score} (${fb.label}) — news flow balanced`);
  }

  if (S.funding != null && Math.abs(S.funding) > 0.0003) {
    score -= 1; why.push(`Funding ${(S.funding * 100).toFixed(4)}%/8h — crowded perp positioning, squeeze risk`);
  } else if (S.funding != null) {
    why.push(`Funding ${(S.funding * 100).toFixed(4)}%/8h — neutral positioning`);
  }

  let cls, label;
  if (score >= 2)      { cls = 'v-sell';    label = 'GREEN — conditions favor selling premium (size normally)'; }
  else if (score >= 0) { cls = 'v-caution'; label = 'AMBER — sell only wide strikes at reduced size'; }
  else                 { cls = 'v-stand';   label = 'RED — stand down / buy-side or spreads only'; }
  return { score, cls, label, why, ivhv };
}

/* --------------------------- desk notes (plain English) ------------------ */
/* The translation layer: turns the same numbers a fund desk reads into
   sentences a first-year retail trader can act on. No jargon unexplained. */
function renderDeskNotes(gate, atm, em, T) {
  const el = document.getElementById('deskNotes');
  if (!el) return;
  const p = [];

  // 1. Where we are
  if (S.spot) {
    const emPct = em != null ? (em / S.spot * 100).toFixed(1) : null;
    p.push(`<b>Where we are.</b> Bitcoin trades at <b>${fmt$(S.spot)}</b>. ` +
      (emPct != null
        ? `The options market is pricing a normal move of about <b>±${emPct}%</b> (±${fmt$(em)}) between now and this expiry. Think of that as the market's own weather forecast — roughly 2 days out of 3, price should stay inside that band.`
        : `Chain data is still loading, so no expected-move estimate yet.`));
  }

  // 2. Is premium rich or cheap?
  if (gate.ivhv != null) {
    if (gate.ivhv >= 1.15) {
      p.push(`<b>Is selling worth it?</b> Options are currently priced <b>${((gate.ivhv - 1) * 100).toFixed(0)}% richer</b> than how much Bitcoin has actually been moving (IV ${fmtPct(atm)} vs realized ${fmtPct(S.hv20)}). That gap is the <i>vol-risk premium</i> — the "insurance markup" you collect as a seller. Today the markup exists.`);
    } else if (gate.ivhv >= 1.0) {
      p.push(`<b>Is selling worth it?</b> Options are priced only slightly above realized movement (IV ${fmtPct(atm)} vs ${fmtPct(S.hv20)}). The seller's edge is thin — like selling insurance at nearly cost price. Acceptable, not exciting.`);
    } else {
      p.push(`<b>Is selling worth it?</b> <span class="neg">No.</span> Options are priced <i>cheaper</i> than Bitcoin's actual movement (IV ${fmtPct(atm)} vs ${fmtPct(S.hv20)}). Selling here is selling insurance below cost — the statistical edge belongs to buyers today.`);
    }
  }

  // 3. The AI forecast
  if (S.kronos?.volAmp != null) {
    const va = S.kronos.volAmp, up = S.kronos.upside;
    if (va >= 80) {
      p.push(`<b>What the AI sees.</b> The Kronos model (trained on 12B financial data points) gives a <b class="neg">${va}% chance volatility EXPANDS</b> in the next 24h${up != null ? ` and a ${up}% chance price ends higher` : ''}. Expanding volatility is the one thing that hurts option sellers most — it's the storm warning. When this number is above 80, funds cut their short-vol books, not grow them.`);
    } else if (va >= 60) {
      p.push(`<b>What the AI sees.</b> Kronos puts vol-expansion odds at <b class="warn">${va}%</b>${up != null ? ` (upside ${up}%)` : ''} — choppier than ideal. Sellers should go wider on strikes and smaller on size.`);
    } else {
      p.push(`<b>What the AI sees.</b> Kronos expects calm: only ${va}% odds of volatility expanding${up != null ? `, upside ${up}%` : ''}. Quiet tape is a premium-seller's best friend.`);
    }
  }

  // 4. Crowd + news
  const crowd = [];
  if (S.fng?.value != null) {
    const fv = S.fng.value;
    crowd.push(fv <= 20 ? `the crowd is in <b class="neg">${S.fng.label || 'Extreme Fear'}</b> (${fv}/100) — historically the zone of violent snap-back rallies`
      : fv >= 80 ? `the crowd is in <b class="warn">${S.fng.label || 'Extreme Greed'}</b> (${fv}/100) — euphoria precedes air-pockets`
      : `crowd mood is mid-range (${fv}/100) — no emotional extreme to fade or fear`);
  }
  if (S.finbert?.score != null) {
    crowd.push(`AI-read news sentiment (FinBERT) is <b>${S.finbert.label}</b> (${S.finbert.score > 0 ? '+' : ''}${S.finbert.score})`);
  }
  if (S.funding != null) {
    crowd.push(Math.abs(S.funding) > 0.0003
      ? `perp funding at ${(S.funding * 100).toFixed(4)}%/8h shows a crowded ${S.funding > 0 ? 'long' : 'short'} side — squeeze fuel`
      : `perp funding is neutral — no crowded side to squeeze`);
  }
  if (crowd.length) p.push(`<b>The crowd.</b> ${crowd.join('; ')}.`);

  // 5. The instruction
  if (gate.cls === 'v-sell') {
    p.push(`<b>Bottom line.</b> <span class="pos">Conditions favor selling premium.</span> The builder below has picked strikes a fund desk would recognize: far enough out to win ~${document.getElementById('pop')?.textContent || '70%+'} of the time, close enough to be paid for the risk. Enter, set the exit rules, and let the math work.`);
  } else if (gate.cls === 'v-caution') {
    p.push(`<b>Bottom line.</b> <span class="warn">Tradeable, but on half rations.</span> Sell wider strikes (drop target |Δ| to 0.10), cut lots in half, and take profits early at 50% of credit. The edge is there but the weather is unsettled.`);
  } else {
    p.push(`<b>Bottom line.</b> <span class="neg">Stand down.</span> This is a day to NOT sell naked options — the desk's most profitable trades are often the ones never placed. If you must trade, use defined-risk spreads (buy a further wing against each short leg) so a wild move can't hurt you beyond a known amount. Re-check tomorrow; regimes flip fast.`);
  }

  el.innerHTML = p.map(x => `<p style="margin:0 0 9px">${x}</p>`).join('');

  const g = document.getElementById('deskGlossary');
  if (g) g.innerHTML =
    `<b>30-second glossary:</b> <i>IV</i> = how big a move options are charging for · ` +
    `<i>Realized/HV</i> = how big moves have actually been · ` +
    `<i>Δ (delta)</i> ≈ odds an option finishes in-the-money (0.15Δ ≈ 15%) · ` +
    `<i>POP</i> = probability the whole trade profits · ` +
    `<i>Strangle</i> = sell one put below + one call above; you win if price stays between them.`;
}

/* ------------------------------ rendering -------------------------------- */
function expLabel(ms) {
  const d = new Date(ms);
  const days = ((ms - Date.now()) / 86400_000).toFixed(1);
  return d.toISOString().slice(0, 10) + ` (${days}d)`;
}

/* --------------------------- Buyer's Radar -------------------------------
   Backtest (OPTION_BUYER_ALPHA.md, post-ETF, costs from real Deribit DVOL):
   - DVOL < 40  -> 10d straddle win 45.9% vs 33.7% base, mean EV +0.95%/trade
                   (monotone: <38 even better, >60 catastrophic -2.94%). p=0.0001.
   - Shock day  -> 5d straddle win 43.2% vs 35.0%, EV +0.34%, p=0.044 (n=37).
   - BBW squeeze, quiet streaks, breakout direction: NO edge once priced with
     real IV — the market already charges for the coil. Reported honestly.   */
function renderBuyerRadar() {
  const el = $('radarVerdict');
  if (!el) return;
  const dv = S.dvol, sh = S.shock;
  $('radarDvol').textContent = dv != null ? dv.toFixed(1) + (S.dvolPrev != null ? ` (${dv >= S.dvolPrev ? '+' : ''}${(dv - S.dvolPrev).toFixed(1)} d/d)` : '') : '—';
  $('radarDvol').className = dv == null ? '' : dv < 40 ? 'pos' : dv < 50 ? 'warn' : 'neg';
  $('radarShock').textContent = sh ? (sh.on ? `YES — ${(sh.lastRet * 100).toFixed(1)}% move (${sh.ratio.toFixed(1)}× normal)` : `no (last day ${(sh.lastRet * 100).toFixed(1)}%, ${sh.ratio.toFixed(1)}× normal)`) : '—';
  $('radarShock').className = sh?.on ? 'warn' : '';

  let cls, label, why = [];
  if (dv == null) { cls = 'v-caution'; label = 'NO DVOL DATA'; why.push('Deribit DVOL fetch failed — radar offline this refresh.'); }
  else if (dv < 40) {
    cls = 'v-sell'; label = 'BUY ZONE — implied vol is statistically too cheap';
    why.push(`DVOL ${dv.toFixed(1)} < 40: post-ETF, 10-day straddles bought here won 45.9% vs 33.7% baseline and averaged +0.95% of spot per trade — the only standing positive-EV buyer condition found (p=0.0001).`);
    why.push('Play: 7–14 day ATM straddle or 25Δ strangle, small size, hold for the move. The market is pricing BTC like a calm stock; BTC has a vol floor.');
  } else if (dv < 50) {
    cls = 'v-caution'; label = 'NEUTRAL — only buy with a reason';
    why.push(`DVOL ${dv.toFixed(1)} in 40–50: EV roughly flat (-0.2%). Buy only into a scheduled macro print (CPI/NFP 12:30 UTC, FOMC 18:00 UTC) inside your expiry, or on a fresh shock day.`);
  } else {
    cls = 'v-stand'; label = "TOO EXPENSIVE — don't buy the fear";
    why.push(`DVOL ${dv.toFixed(1)} > 50: buyers lost ${dv >= 60 ? '-2.94%' : '-1.41%'} per 10d straddle on average in this zone. The premium IS the panic — this is the seller's harvest, not the buyer's lottery ticket.`);
  }
  if (sh?.on) why.push(`Shock day just printed (${(sh.lastRet * 100).toFixed(1)}%): vol clusters — 5-day straddles entered on shock closes won 43.2% vs 35.0% base (small edge, n=37; dealers re-mark IV with a lag).`);
  why.push('What does NOT work (verified): Bollinger squeezes, "three quiet days", and breakout-direction bets all show zero edge once priced with real implied vol — the coil is already in the premium. See OPTION_BUYER_ALPHA.md.');

  el.textContent = label;
  el.className = 'verdict ' + cls;
  $('radarWhy').innerHTML = why.map(w => '• ' + w).join('<br>');
}

/* Seller's Compass — directional option-SELLING regimes, backtested weekly 25Δ
   shorts priced at real DVOL (SELLER_DIRECTIONAL_ALPHA.md, 894 days):
   - PRIME  : dd90 < -15% AND DVOL > 50  -> put EV +0.95%/wk, win 92.7%, worst -3.5% (p=0.0000)
   - GOOD   : uptrend & DVOL>50 (+0.81%) | funding 7d<0 (+0.81%) | funding<20pct (+0.73%)
   - ANTI   : shock day (-1.04%, p=.015), RSI<30 (-0.78%, p=.0002), RSI>70 calls (-0.62%),
              DVOL<40 strangles (-0.47%) — all significant LOSERS for sellers.
   - Call-side directional selling alone: p=0.18, NOT validated — reported honestly. */
function renderSellerCompass() {
  const el = $('scVerdict');
  if (!el) return;
  const t = S.trend, f = S.fundHist, dv = S.dvol, sh = S.shock;

  $('scTrend').textContent = t ? `${t.above ? 'UP (above MA100)' : 'DOWN (below MA100)'} · ${t.dd90.toFixed(1)}% off 90d high` : '—';
  $('scTrend').className = t ? (t.above ? 'pos' : 'neg') : '';
  $('scFund').textContent = f ? `${(f.avg7 * 100).toFixed(4)}%/day (7d avg) · ${f.pct.toFixed(0)}th pctile (180d)` : '—';
  $('scFund').className = f ? (f.avg7 < 0 || f.pct < 20 ? 'pos' : f.pct > 80 ? 'warn' : '') : '';
  $('scRsi').textContent = t ? t.rsi.toFixed(0) : '—';
  $('scRsi').className = t ? (t.rsi < 30 || t.rsi > 70 ? 'neg' : '') : '';

  let cls, label, why = [];
  const anti = [];
  if (sh?.on) anti.push(`a shock day just printed (${(sh.lastRet * 100).toFixed(1)}%) — selling puts on shock days lost -1.04%/wk (p=0.015); fear must become PERSISTENT first`);
  if (t && t.rsi < 30) anti.push(`RSI ${t.rsi.toFixed(0)} < 30 — "oversold" kept falling: put-selling here lost -0.78%/wk (p=0.0002)`);
  if (t && t.rsi > 70) anti.push(`RSI ${t.rsi.toFixed(0)} > 70 — never cap a hot rally: call-selling here lost -0.62%/wk (p=0.0007)`);
  if (dv != null && dv < 40) anti.push(`DVOL ${dv.toFixed(1)} < 40 — vol is too cheap to sell (strangles lost -0.47%/wk here, p=0.0007). This is the Buyer's Radar zone.`);

  const prime = t && dv != null && t.dd90 < -15 && dv > 50;
  const good = [];
  if (t && dv != null && t.above && dv > 50) good.push(`uptrend + DVOL>50 ("paid twice"): put EV +0.81%/wk, win 89% (p=0.0000)`);
  if (f && f.avg7 < 0) good.push(`7d funding negative — leverage flushed: put EV +0.81%/wk, win 90%, worst week only -5.0%`);
  else if (f && f.pct < 20) good.push(`funding ${f.pct.toFixed(0)}th pctile (cold crowd): put EV +0.73%/wk, win 90% (p=0.0005)`);

  if (anti.length) {
    cls = 'v-stand'; label = 'STAND ASIDE — anti-signal active';
    why = anti.map(a => 'Blocked: ' + a);
    if (prime || good.length) why.push('Filters that would otherwise fire: ' + (prime ? 'PRIME fear-zone; ' : '') + good.join('; ') + ' — the anti-signal wins; same trade, wrong week.');
  } else if (prime) {
    cls = 'v-sell'; label = 'PRIME — sell puts into persistent fear';
    why.push(`Drawdown ${t.dd90.toFixed(1)}% + DVOL ${dv.toFixed(1)}: the crash already happened but fear is still priced. 7d 25Δ puts: +0.95%/wk, 92.7% win, worst week -3.5% (p=0.0000; 14d even better: 96.7% win). The best risk-adjusted seller trade in the whole study.`);
  } else if (good.length) {
    cls = 'v-sell'; label = 'GOOD — sell puts, conditions validated';
    why = good.map(g => '• '.slice(0, 0) + g);
  } else if (dv != null && dv > 55) {
    cls = 'v-caution'; label = 'NEUTRAL-PLUS — strangle harvest zone';
    why.push(`No directional filter on, but DVOL ${dv.toFixed(1)} > 55: non-directional 25Δ strangles earned +1.21%/wk (p=0.0000) — with the full -21% fat-tail risk back on. Size accordingly.`);
  } else {
    cls = 'v-caution'; label = 'NEUTRAL — baseline premium only';
    why.push('No validated regime active. Unconditional 25Δ put selling still earns ~+0.33%/wk (the standing variance premium), but with -21% worst weeks. Better entries come to those who wait.');
  }

  // Kronos: live overlay, honestly unbacktested (no forecast archive exists).
  const ku = S.kronos?.upside;
  if (ku != null && (cls === 'v-sell')) {
    why.push(ku >= 55 ? `Kronos overlay: ${ku}% upside prob agrees — full planned size is defensible.`
           : ku <= 45 ? `Kronos overlay: only ${ku}% upside prob — consider half size. (Overlay is live-only; Kronos has no backtestable history.)`
           : `Kronos overlay: ${ku}% upside prob, neutral — no size adjustment.`);
  }
  why.push(`Honesty note: the directional edge is PUT-side only — "sell calls in downtrends" failed significance (p=0.18). Skew means real put credit is richer than modeled. See SELLER_DIRECTIONAL_ALPHA.md.`);

  el.textContent = label;
  el.className = 'verdict ' + cls;
  $('scWhy').innerHTML = why.map(w => (w.startsWith('•') ? w : '• ' + w)).join('<br>');
}

/* Daily Desk — 1DTE selling (DAILY_EXPIRY_ALPHA.md, 998 daily expiries at real DVOL).
   Settlement every day 12:00 UTC = 5:30 PM IST on Delta Exchange.
   - PRIME : Sat-entry (expiry Sunday noon) straddle +1.20%/d, 92.3% win, worst -3.2% (p=0.0000)
             but decaying: 2023 +1.50 -> 2026 +0.55 — trade at HALF size.
   - JUNIOR: Fri-entry (expiry Sat noon) straddle +0.65%/d (p=0.033).
   - ANTI  : Mon entry (expiry Tue noon) strangle -0.095%/d (p=0.006); shock day; RSI<30 puts -0.41%/d (p=0.009).
   - GOOD  : uptrend put +0.21-0.23%/d (p<0.006); funding7<0 put +0.26%/d, 92% win.
   - FLIP  : DVOL<40 strangle is +0.25%/d at 1DTE — the weekly no-sell rule does NOT apply.
   - Entry clock: 18:00 UTC entry beats the 24h hold (+0.56% vs +0.40%); 06:00 UTC entry = same EV, 1/4 the tail. */
function renderDailyDesk() {
  const el = $('ddVerdict');
  if (!el) return;
  const t = S.trend, f = S.fundHist, dv = S.dvol, sh = S.shock;
  const now = new Date();
  const todayNoon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  const expiryMs = now.getTime() < todayNoon ? todayNoon : todayNoon + 86400_000;
  const expDow = new Date(expiryMs).getUTCDay();            // 0=Sun..6=Sat (UTC day of expiry noon)
  const hrsLeft = (expiryMs - now.getTime()) / 3600_000;
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  $('ddWindow').textContent = `${days[expDow]} 12:00 UTC (${hrsLeft.toFixed(1)}h away) — window = ${days[(expDow + 6) % 7]} noon → ${days[expDow]} noon`;

  // Entry-clock line (study: variance is back-loaded into the US session right after listing)
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  let clockTxt, clockCls = '';
  if (utcH >= 12 && utcH < 18) { clockTxt = `US session live — 31% of the day's variance burns in the first 6h. Patient entry at 18:00 UTC (11:30 PM IST) historically earned MORE (+0.56% vs +0.40%) with smaller bombs.`; clockCls = 'warn'; }
  else if (utcH >= 18 || utcH < 2) { clockTxt = `Prime entry zone (18:00–02:00 UTC): the loud US hours are behind you; 18h-entry EV +0.56%/trade, worst -13% vs -16% for the full day.`; clockCls = 'pos'; }
  else if (utcH >= 2 && utcH < 9) { clockTxt = `Morning entry (06:00 UTC / 11:30 AM IST, ~6h left): same EV as the full day (+0.40%) at one-quarter the worst loss (-4.3%). The nervous seller's entry.`; clockCls = 'pos'; }
  else { clockTxt = `Late window (<3h): EV +0.29%/trade, thin but fast. Quote-check spreads — the book thins near settlement.`; }
  $('ddHours').textContent = clockTxt;
  $('ddHours').className = clockCls;

  // Live shortest-tenor ATM IV vs DVOL — how much of the edge is already priced in
  let ivLine = 'no 1-day chain loaded', ivCls = '';
  try {
    const exps = [...S.chainByExpiry.keys()].filter(e => e > Date.now()).sort((a, b) => a - b);
    if (exps.length && dv != null) {
      const { rows } = enrich(exps[0]);
      const iv = atmIv(rows);
      if (iv != null) {
        const ratio = iv * 100 / dv;
        ivLine = `nearest-expiry ATM IV ${(iv * 100).toFixed(0)}% vs DVOL ${dv.toFixed(0)} → ${ratio.toFixed(2)}×`;
        if (ratio <= 0.60) { ivLine += ' — short-tenor IV already crushed: the market HAS priced the quiet window; backtest EVs are upper bounds, expect less.'; ivCls = 'warn'; }
        else if (ratio >= 0.90) { ivLine += ' — short-tenor IV near 30d levels: the calendar discount is NOT priced in; the backtest edge is live.'; ivCls = 'pos'; }
        else { ivLine += ' — partial discount (typical): roughly half the structural edge remains.'; }
      }
    }
  } catch (e) { /* chain not ready */ }
  $('ddIv').textContent = ivLine;
  $('ddIv').className = ivCls;

  let cls, label, why = [];
  const anti = [];
  if (sh?.on) anti.push(`shock day just printed (${(sh.lastRet * 100).toFixed(1)}%) — never sell the day after a shock; fresh panic is one of the two ways daily sellers die`);
  if (t && t.rsi < 30) anti.push(`RSI ${t.rsi.toFixed(0)} < 30 — still poison at 1 day: put-selling here lost -0.41%/d (p=0.009)`);
  if (expDow === 2) anti.push(`Monday-entry window (expiry Tuesday noon): the whole weekend's news reprices through a full US session — strangle -0.095%/d (p=0.006). The worst calendar slot of the week.`);

  if (anti.length) {
    cls = 'v-stand'; label = 'STAND ASIDE — daily anti-signal active';
    why = anti.map(a => 'Blocked: ' + a);
  } else if (expDow === 0) {
    cls = 'v-sell'; label = 'PRIME — Saturday lull: sell the ATM straddle / 25Δ strangle';
    why.push(`Sat-noon→Sun-noon realizes only 33–45% of weekday vol every year since 2022 (no US session, no macro, no ETF flows). Straddle +1.20%/d, 92.3% win, worst -3.2% (p=0.0000); strangle +0.66%/d, 93% win.`);
    why.push(`Decay warning: Sat EV 2023 +1.50% → 2026 +0.55%. The edge is structural but shrinking — trade at HALF the size your backtest courage suggests, and check the live IV line above first.`);
  } else if (expDow === 6) {
    cls = 'v-sell'; label = 'GOOD — Friday entry: the junior weekend trade';
    why.push(`Fri-noon→Sat-noon already leans into the lull: straddle +0.65%/d (p=0.033), and Fri+Sat combined ran +0.93%/d (p=0.0000). Tomorrow's Saturday entry is the main event.`);
  } else if (expDow === 1) {
    cls = 'v-caution'; label = 'CAUTION — Sunday entry: the lull does NOT extend';
    why.push(`Sun-noon→Mon-noon holds the single worst day in the 998-day sample: -16.1% (Aug 4 2024, yen-carry crash weekend). The weekend trade is Saturday ONLY. If you sell, size as if tonight is the night.`);
  } else {
    const good = [];
    if (t && dv != null && t.above && dv > 50) good.push(`uptrend + DVOL>50: 25Δ put +0.23%/d (p=0.004) — the best surviving daily put filter`);
    else if (t && t.above) good.push(`uptrend above MA100: 25Δ put +0.21%/d (p=0.006)`);
    if (f && f.avg7 < 0) good.push(`7d funding negative — leverage flushed: 25Δ put +0.26%/d, 92% win, worst day -3.5%`);
    if (good.length) {
      cls = 'v-sell'; label = 'GOOD — sell the 25Δ put (directional daily)';
      why = good.slice();
    } else {
      cls = 'v-caution'; label = 'NEUTRAL — 25Δ strangle, fat premium only';
      why.push(`No directional filter on. Unconditional 25Δ strangle earns +0.21%/d gross, +0.13%/d after Delta fees. ${dv != null && dv < 40 ? `DVOL ${dv.toFixed(1)} < 40 is FINE at 1DTE (+0.25%/d) — the weekly no-sell-below-40 rule does not apply to dailies; overnight protection always trades rich.` : 'The variance premium never fully disappears at the 1-day tenor.'}`);
    }
    if (t && t.rsi > 70) why.push(`RSI ${t.rsi.toFixed(0)} > 70 — call-side caution only at 1DTE (-0.03%/d, p=0.11): lean put-side, skip the call leg if nervous.`);
  }

  // Kronos overlay (live-only) on directional days
  const ku = S.kronos?.upside;
  if (ku != null && cls === 'v-sell' && label.includes('put')) {
    why.push(ku >= 55 ? `Kronos overlay: ${ku}% upside prob agrees — full planned size defensible.`
           : ku <= 45 ? `Kronos overlay: only ${ku}% upside prob — half size.`
           : `Kronos overlay: ${ku}% neutral — no adjustment.`);
  }
  why.push(`Fees rule: sell FAT premium (ATM/25Δ) only — 10Δ wings are net-NEGATIVE after Delta fees (fees eat 33% of even the 25Δ put). Worst day in sample was -16% of notional: size so that day is annoying, not fatal. Full study: DAILY_EXPIRY_ALPHA.md.`);

  el.textContent = label;
  el.className = 'verdict ' + cls;
  $('ddWhy').innerHTML = why.map(w => (w.startsWith('Blocked') ? '• ' + w : '• ' + w)).join('<br>');
}

function renderAll() {
  const expiry = S.selectedExpiry;
  const { rows, T } = enrich(expiry);
  const atm = atmIv(rows);

  $('spot').textContent = fmt$(S.spot);
  $('atmIv').textContent = fmtPct(atm);
  $('hv20').textContent = fmtPct(S.hv20);
  const gate = computeGate(atm);
  $('ivhv').textContent = gate.ivhv != null ? gate.ivhv.toFixed(2) + '×' : '—';
  $('ivhv').className = gate.ivhv >= 1.15 ? 'pos' : gate.ivhv <= 1.0 ? 'neg' : 'warn';
  const em = (atm != null) ? S.spot * atm * Math.sqrt(T) : null;
  $('expMove').textContent = em != null ? '±' + fmt$(em).slice(1) : '—';
  $('funding').textContent = S.funding != null ? (S.funding * 100).toFixed(4) + '% /8h' : '—';

  $('krUp').textContent  = S.kronos?.upside  != null ? S.kronos.upside + '%'  : 'n/a (run snapshot or kronos_local)';
  $('krVol').textContent = S.kronos?.volAmp != null ? S.kronos.volAmp + '%' : 'n/a';
  $('krVol').className   = (S.kronos?.volAmp ?? 0) >= 80 ? 'neg' : (S.kronos?.volAmp ?? 0) >= 60 ? 'warn' : 'pos';
  $('fng').textContent   = S.fng?.value != null ? `${S.fng.value} · ${S.fng.label || ''}` : 'n/a';
  $('vrp').textContent   = gate.ivhv != null ? (gate.ivhv >= 1.15 ? 'PRESENT' : gate.ivhv >= 1.0 ? 'THIN' : 'ABSENT') : '—';

  const v = $('verdict');
  v.textContent = gate.label;
  v.className = 'verdict ' + gate.cls;
  $('verdictWhy').innerHTML = gate.why.map(w => '• ' + w).join('<br>');

  renderStrangle(rows, T, em);
  renderChain(rows, expiry);
  renderDeskNotes(gate, atm, em, T);   // after renderStrangle: Desk Notes reads the live POP figure
  renderClock();                       // hour/day/month seasonality from the 2015-2026 study
  renderBuyerRadar();                  // DVOL-zone + shock-day buyer signals (OPTION_BUYER_ALPHA.md)
  renderSellerCompass();               // directional put-selling regimes (SELLER_DIRECTIONAL_ALPHA.md)
  renderDailyDesk();                   // 1DTE calendar & clock (DAILY_EXPIRY_ALPHA.md)
}

function renderStrangle(rows, T, em) {
  const target = +$('deltaSlider').value / 100;
  const lots = +$('lotSlider').value;
  const sizeBtc = lots * 0.001;                       // Delta Exchange BTC option lot = 0.001 BTC
  $('deltaVal').textContent = target.toFixed(2);
  $('lotVal').textContent = lots;

  const put = pickLeg(rows, target, 'P');
  const call = pickLeg(rows, target, 'C');
  if (!put || !call) {
    $('putLeg').textContent = $('callLeg').textContent = 'insufficient chain liquidity';
    return;
  }
  S._legs = { put: put.strike, call: call.strike };

  const credit = (put.putMark + call.callMark) * sizeBtc;
  const beLo = put.strike - (put.putMark + call.callMark);
  const beHi = call.strike + (put.putMark + call.callMark);
  const pop = 1 - (Math.abs(put.putDelta) + Math.abs(call.callDelta));

  // margin: full on the expensive leg, 50% on the cheaper (strangle benefit heuristic)
  const mP = deltaExMarginPerLeg(put.strike, put.putMark, true)  * sizeBtc;
  const mC = deltaExMarginPerLeg(call.strike, call.callMark, false) * sizeBtc;
  const margin = Math.max(mP, mC) + 0.5 * Math.min(mP, mC);

  $('putLeg').textContent = `${put.strike.toLocaleString()} P @ ${fmt$(put.putMark)}  (Δ ${put.putDelta.toFixed(2)}, IV ${fmtPct(put.putIv)})`;
  $('callLeg').textContent = `${call.strike.toLocaleString()} C @ ${fmt$(call.callMark)}  (Δ +${call.callDelta.toFixed(2)}, IV ${fmtPct(call.callIv)})`;
  $('credit').textContent = fmt$(credit) + `  (${sizeBtc} BTC notional/leg)`;
  $('breakevens').textContent = `${fmt$(beLo)}  /  ${fmt$(beHi)}`;
  $('pop').textContent = fmtPct(pop, 0);
  $('margin').textContent = fmt$(margin);
  $('rom').textContent = margin > 0 ? fmtPct(credit / margin) : '—';
  $('cem').textContent = em ? ((put.putMark + call.callMark) / em).toFixed(2) + '× of 1σ move' : '—';

  const wingWidthPct = ((call.strike - put.strike) / S.spot * 100).toFixed(1);
  $('legNotes').textContent =
    `Strikes span ${wingWidthPct}% of spot. Defense plan: roll the tested leg when its delta doubles, ` +
    `or close the structure at 50% of max profit / 2× credit loss — whichever comes first.`;
}

function renderChain(rows, expiry) {
  $('chainExpiry').textContent = '· ' + expLabel(expiry);
  const tb = $('chainTbl').querySelector('tbody');
  const atmStrike = rows.length ? rows.reduce((a, b) =>
    Math.abs(b.strike - S.spot) < Math.abs(a.strike - S.spot) ? b : a).strike : null;
  tb.innerHTML = rows
    .filter(r => Math.abs(r.strike - S.spot) / S.spot < 0.35)  // ±35% window
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
  $('status').textContent = 'loading chain…';
  try {
    await Promise.allSettled([fetchChain(), fetchHv20(), fetchFunding(), fetchFundingHist(), fetchDvol(), fetchSnapshots()]);
    if (!S.chainByExpiry.size) throw new Error('empty chain');
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
    $('status').textContent = 'load failed — ' + e.message;
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
  setInterval(refresh, 5 * 60_000);   // 5-min auto refresh, well inside free limits
});
