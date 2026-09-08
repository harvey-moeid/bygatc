/**
 * data.js  (v4.2)
 * =====================================================================
 * v4.2 changes from v4.1:
 *   - Removed dead code: parseBGTCHtml(), findNearbyPercent(),
 *     parseSourceTs() -- BGTC is now delivered via Worker KV push,
 *     direct HTML scraping has been dropped entirely.
 *   - Removed dedupeNews() and scoreSentiment() -- news items arrive
 *     pre-deduped and pre-scored from /api/enrichment/news (Worker cron).
 *     Browser-side copies were never invoked.
 * v4.1 changes from v4:
 *   - Prefer ./data/*.json snapshots (written by GitHub Actions enrichment
 *     cron) over browser CORS proxies.
 *   - Added Crypto.com Exchange as a secondary price source.
 *   - News caches namespaced (news_exa / news_cp / news_gdelt / news_bigdata)
 *     and the dashboard picks the freshest non-empty.
 *   - EXA placeholder string is no longer treated as a real key.
 *   - Every fetcher returns a `_freshness` field (fresh|stale|offline).
 *   - Funding `flag` thresholds documented and tightened to match PDF s3.
 *   - BGTC source timestamp respects an optional tz hint from the snapshot.
 */
const DataLayer = (() => {

  // -- CLOUDFLARE WORKER BASE URL -----------------------------------------
  const WORKER_BASE = (typeof window !== 'undefined' && window.WORKER_BASE)
    ? window.WORKER_BASE
    : '/api';

  async function workerFetch(path, timeoutMs = 9000) {
    const r = await fetch(`${WORKER_BASE}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`Worker ${path}: HTTP ${r.status}`);
    return r.json();
  }

  const SNAPSHOT_ROOT = './data';
  const SNAPSHOT_MAX_AGE_MS = 45 * 60_000;

  async function tryLoadSnapshot(name) {
    try {
      const r = await fetch(`${SNAPSHOT_ROOT}/${name}.json?_=${Date.now()}`,
        { signal: AbortSignal.timeout(3500) });
      if (!r.ok) return null;
      const j = await r.json();
      const updatedMs = j._updatedMs || j.ts || null;
      if (updatedMs && Date.now() - updatedMs > SNAPSHOT_MAX_AGE_MS) {
        return { ...j, _freshness: 'stale-snapshot' };
      }
      return { ...j, _freshness: 'fresh-snapshot' };
    } catch { return null; }
  }

  function cacheGet(key) {
    try {
      const item = JSON.parse(localStorage.getItem('btc_cache_v4_' + key));
      if (item && Date.now() < item.expires) return item.data;
    } catch {}
    return null;
  }
  function cacheSet(key, data, ttlMs) {
    try {
      localStorage.setItem('btc_cache_v4_' + key,
        JSON.stringify({ data, expires: Date.now() + ttlMs }));
    } catch {}
  }

  async function fetchPrice() {
    const cached = cacheGet('price');
    if (cached) return cached;
    try {
      const data = await workerFetch('/market/price');
      if (!data.price) throw new Error('No data');
      cacheSet('price', data, 60_000);
      cacheSet('price_stale', data, 86400_000);
      return data;
    } catch (e) {
      console.error('[fetchPrice] worker failed:', e);
      return cacheGet('price_stale');
    }
  }

  async function fetchHourly() {
    const cached = cacheGet('hourly');
    if (cached) return cached;
    try {
      const data = await workerFetch('/market/hourly');
      cacheSet('hourly', data, 300_000);
      cacheSet('hourly_stale', data, 86400_000);
      return data;
    } catch (e) { console.error('[fetchHourly]', e); return cacheGet('hourly_stale') || []; }
  }

  async function fetchDaily() {
    const cached = cacheGet('daily');
    if (cached) return cached;
    try {
      const data = await workerFetch('/market/daily');
      cacheSet('daily', data, 3600_000);
      cacheSet('daily_stale', data, 86400_000 * 2);
      return data;
    } catch (e) { console.error('[fetchDaily]', e); return cacheGet('daily_stale') || []; }
  }

  async function fetchFunding() {
    const cached = cacheGet('funding');
    if (cached) return cached;
    try {
      const data = await workerFetch('/market/funding');
      cacheSet('funding', data, 600_000);
      cacheSet('funding_stale', data, 86400_000);
      return data;
    } catch (e) { console.error('[fetchFunding]', e); return cacheGet('funding_stale'); }
  }

  async function fetchFearGreed() {
    const cached = cacheGet('fg');
    if (cached) return cached;

    try {
      const snap = await tryLoadSnapshot('fg');
      if (snap?._freshness === 'fresh-snapshot') {
        cacheSet('fg', snap, 3600_000 * 6);
        cacheSet('fg_stale', snap, 86400_000);
        return snap;
      }
    } catch { /* skip */ }

    try {
      const data = await workerFetch('/enrichment/fg');
      cacheSet('fg', data, 3600_000 * 6);
      cacheSet('fg_stale', data, 86400_000);
      return data;
    } catch (e) { console.error('[fetchFearGreed]', e); return cacheGet('fg_stale'); }
  }

  async function fetchOptions() {
    const cached = cacheGet('options');
    if (cached) return cached;
    try {
      const data = await workerFetch('/market/options', 12000);
      cacheSet('options', data, 600_000);
      cacheSet('options_stale', data, 86400_000);
      return data;
    } catch (e) { console.error('[fetchOptions]', e); return cacheGet('options_stale'); }
  }

  // -- BGTC (formerly Kronos) ---------------------------------------------
  async function fetchBGTC() {
    const cached = cacheGet('BGTC');
    if (cached) return cached;

    // Primary: Worker KV -- diisi GH Actions via POST /api/noctua/push
    try {
      const data = await workerFetch('/noctua/latest');
      if (data?.upside != null) {
        cacheSet('BGTC', data, 3600_000 * 3);
        cacheSet('BGTC_stale', data, 86400_000 * 3);
        return data;
      }
    } catch (e) {
      console.warn('[fetchBGTC] worker noctua miss:', e.message);
    }

    // Fallback: ./data/BGTC.json (GH Actions commit snapshot)
    const snap = await tryLoadSnapshot('BGTC');
    if (snap?.upside != null) {
      cacheSet('BGTC', snap, 3600_000);
      cacheSet('BGTC_stale', snap, 86400_000 * 3);
      return snap;
    }

    return cacheGet('BGTC_stale');
  }

  async function fetchNewsSentiment() {
    const cached = cacheGet('news');
    if (cached) return cached;

    try {
      const data = await workerFetch('/enrichment/news');
      if (data?.items?.length) {
        cacheSet('news', data, 3600_000);
        cacheSet('news_stale', data, 86400_000);
        return data;
      }
    } catch (e) {
      console.warn('[fetchNewsSentiment] worker enrichment miss:', e.message);
    }

    const snap = await tryLoadSnapshot('news');
    if (snap?.items?.length) {
      cacheSet('news_stale', snap, 86400_000);
      return snap;
    }

    return cacheGet('news_stale') || { items: [], ts: Date.now(), source: 'offline' };
  }

  function computeHV20(dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 21) return null;
    const closes = dailyCandles.slice(-21).map(c => c.c);
    const logRets = [];
    for (let i = 1; i < closes.length; i++) logRets.push(Math.log(closes[i] / closes[i-1]));
    const mean = logRets.reduce((a,b) => a+b, 0) / logRets.length;
    const variance = logRets.reduce((s, r) => s + (r-mean)**2, 0) / (logRets.length - 1);
    const dailyStd = Math.sqrt(variance);
    const annualised = dailyStd * Math.sqrt(365) * 100;
    const oneDay = annualised / Math.sqrt(365);
    return { annualised, oneDay, dailyStd, n: logRets.length };
  }

  function computeHV20Series(dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 25) return [];
    const closes = dailyCandles.map(c => c.c);
    const logRets = [];
    for (let i = 1; i < closes.length; i++) logRets.push(Math.log(closes[i] / closes[i-1]));
    const out = [];
    for (let i = 19; i < logRets.length; i++) {
      const w = logRets.slice(i-19, i+1);
      const mean = w.reduce((a,b)=>a+b,0) / w.length;
      const v = w.reduce((s,r)=>s+(r-mean)**2,0) / (w.length-1);
      out.push({
        t: dailyCandles[i+1].t,
        hv20: Math.sqrt(v) * Math.sqrt(365) * 100,
      });
    }
    return out;
  }

  function computeATR7(dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 7) return null;
    const last7 = dailyCandles.slice(-7);
    const ranges = last7.map(c => (c.h - c.l) / ((c.h + c.l) / 2) * 100);
    return ranges.reduce((a,b) => a+b, 0) / ranges.length;
  }

  function findAtmIv(options, spot) {
    if (!options?.length) return null;
    const expiryMap = {};
    options.forEach(o => { (expiryMap[o.expiry] ||= []).push(o); });
    const parseExp = s => {
      const m = s.match(/(\d{1,2})(\w{3})(\d{2})/);
      if (!m) return Infinity;
      const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
      return new Date(2000 + +m[3], months[m[2].toUpperCase()], +m[1]).getTime();
    };
    const now = Date.now();
    const expiries = Object.keys(expiryMap)
      .map(e => ({ exp: e, t: parseExp(e) }))
      .filter(x => x.t > now)
      .sort((a,b) => a.t - b.t);
    if (!expiries.length) return null;
    const nearest = expiryMap[expiries[0].exp];
    const strikes = [...new Set(nearest.map(o => o.strike))]
      .sort((a,b) => Math.abs(a-spot) - Math.abs(b-spot));
    for (const k of strikes) {
      const call = nearest.find(o => o.strike === k && o.type === 'C');
      const put  = nearest.find(o => o.strike === k && o.type === 'P');
      if (call && put && (call.markIv || put.markIv)) {
        const iv = (call.markIv + put.markIv) / 2;
        return {
          atmStrike:       k,
          atmIv:           iv,
          callMark:        call.mark * (call.underlying || spot),
          putMark:         put.mark  * (put.underlying  || spot),
          straddleCost:    (call.mark + put.mark) * (call.underlying || spot),
          straddleCostPct: ((call.mark + put.mark) * 100),
          expiry:          expiries[0].exp,
          daysToExpiry:    (expiries[0].t - now) / 86400_000,
        };
      }
    }
    return null;
  }

  function computeRanger(dailyCandles, fg, ivHvRatio) {
    const atr7 = computeATR7(dailyCandles);
    if (!atr7) return null;
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const dow = nowIST.getDay();
    const dowMults = [1.12, 1.08, 1.02, 0.98, 0.97, 1.05, 1.10];
    const dowMult = dowMults[dow];
    const ivHv = ivHvRatio || 1.40;
    const volRatio = 0.85;
    const fgFactor = 1 + (50 - (fg?.value || 50)) / 200;
    const raw  = atr7 * Math.pow(ivHv, 0.20) * Math.pow(volRatio, 0.12) * Math.pow(dowMult, 0.05) * fgFactor;
    const safe = raw * 2.2;
    return { atr7, ivHv, volRatio, dowMult, fgFactor, raw, safe };
  }

  function classifyRegime(atmIvPct, hv20Ann) {
    if (!atmIvPct || !hv20Ann) return { ratio: null, regime: 'unknown', label: '—', allowTrade: false, sizing: 0 };
    const ratio = atmIvPct / hv20Ann;
    let regime, label, allowTrade, sizing;
    if      (ratio < 1.2) { regime = 'green';     label = 'CALM';     allowTrade = true;  sizing = 1.0; }
    else if (ratio < 1.4) { regime = 'green';     label = 'NORMAL';   allowTrade = true;  sizing = 0.7; }
    else if (ratio < 1.6) { regime = 'amber';     label = 'CAUTION';  allowTrade = true;  sizing = 0.4; }
    else if (ratio < 1.8) { regime = 'amber-dark';label = 'REDUCED';  allowTrade = true;  sizing = 0.2; }
    else                  { regime = 'red';        label = 'NO-TRADE'; allowTrade = false; sizing = 0;   }
    return { ratio, regime, label, allowTrade, sizing, ivPct: atmIvPct, hv20: hv20Ann };
  }

  function nextDayMoveOdds(ratio) {
    if (ratio == null) return null;
    if (ratio > 1.76) {
      return {
        regimeType: 'high-iv',
        description: 'Elevated IV/HV20 regime — realised vol likely to overshoot',
        odds: [
          { move: '>= 2%',  prob: 0.33  },
          { move: '>= 4%',  prob: 0.16  },
          { move: '>= 6%',  prob: 0.087 },
          { move: '>= 8%',  prob: 0.061 },
          { move: '>= 10%', prob: 0.045 },
        ],
        daysPct: 10,
      };
    }
    return {
      regimeType: 'normal',
      description: 'Normal regime — volatility-clustered, tails contained',
      odds: [
        { move: 'Range <= 1x hv20_1d',   prob: 0.26 },
        { move: 'Range <= 1.5x hv20_1d', prob: 0.56 },
        { move: 'Range <= 2x hv20_1d',   prob: 0.76 },
        { move: 'Range <= 2.5x hv20_1d', prob: 0.87 },
        { move: 'Range <= 3x hv20_1d',   prob: 0.93 },
      ],
      daysPct: 90,
    };
  }

  function touchProbability(distancePct, hv20_1d) {
    if (!hv20_1d || hv20_1d <= 0) return null;
    const k = distancePct / hv20_1d;
    if (k >= 3.0) return 0.07;
    if (k >= 2.5) return 0.13;
    if (k >= 2.0) return 0.24;
    if (k >= 1.5) return 0.44;
    if (k >= 1.0) return 0.74;
    return 0.90;
  }

  function computeSessionContext() {
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const h = nowIST.getHours() + nowIST.getMinutes() / 60;
    let phase, advice, tier;
    if      (h >= 5.5  && h < 8.5)  { phase = 'Pre-Calm';            advice = 'Wait for calm window (08:30-12:30 IST) for tight spreads.';            tier = 'neutral'; }
    else if (h >= 8.5  && h < 12.5) { phase = 'CALM ★ (best entry)'; advice = 'Ideal execution window. Run IV/HV20 + BGTC checks now.';             tier = 'best';    }
    else if (h >= 12.5 && h < 14)   { phase = 'Post-Calm';           advice = 'Still relatively calm. OK to enter but vol rising soon.';            tier = 'ok';      }
    else if (h >= 14   && h < 17.5) { phase = 'Pre-Volatile';        advice = 'Secondary entry OK 16:30-17:20 for next-day structure.';             tier = 'warn';    }
    else if (h >= 17.5 && h < 18.5) { phase = 'Expiry Transition';   advice = '17:30 IST Delta expiry. Avoid new entries on old structure.';       tier = 'skip';    }
    else if (h >= 18.5 || h < 0.5)  { phase = 'VOLATILE (EU+US)';    advice = 'Highest realised vol window — DO NOT enter new short premium.';    tier = 'skip';    }
    else                             { phase = 'Late-Night';          advice = 'Asian illiquid hours. Monitor only, don\'t trade.';                tier = 'neutral'; }
    return { phase, advice, tier, istHour: h };
  }

  function buildRetailPlan({
    price, options, atmInfo, hv20, BGTCUpside, regime,
    shortLots = 60, safetyFactor = 1.15, touchThreshold = 0.10,
  }) {
    if (!price || !atmInfo || !hv20 || !options) {
      return { ok: false, reason: 'Missing inputs (price/ATM/HV20/options)' };
    }
    if (!regime.allowTrade) {
      return { ok: false, reason: `IV/HV20 = ${regime.ratio?.toFixed(2)} — ${regime.label}. Skip today.` };
    }
    const direction = BGTCUpside >= 55 ? 'bullish' : BGTCUpside <= 45 ? 'bearish' : 'neutral';
    if (direction === 'neutral') {
      return { ok: false, reason: `BGTC ${BGTCUpside}% — 50/50. No directional edge — use symmetric condor instead.` };
    }
    const sellSide = direction === 'bullish' ? 'P' : 'C';
    const sellSideLabel = direction === 'bullish' ? 'PUTS (below spot)' : 'CALLS (above spot)';
    const reqPremPerLot = (atmInfo.straddleCost * safetyFactor) / shortLots;
    const candidates = options
      .filter(o => o.expiry === atmInfo.expiry && o.type === sellSide)
      .map(o => ({
        ...o,
        premium: o.mark * (o.underlying || price),
        distPct: ((o.strike - price) / price) * 100,
        absDist: Math.abs(((o.strike - price) / price) * 100),
      }))
      .filter(o => sellSide === 'P' ? o.strike < price : o.strike > price);
    const viable = candidates.filter(o => o.premium >= reqPremPerLot);
    if (!viable.length) {
      return {
        ok: false,
        reason: `No OTM ${sellSideLabel} pay >= $${reqPremPerLot.toFixed(2)}/lot required to finance ${shortLots}-lot wing.`,
        direction, sellSide, atmInfo, reqPremPerLot, candidates: candidates.slice(0, 5),
      };
    }
    const scored = viable.map(o => ({ ...o, touchProb: touchProbability(o.absDist, hv20.oneDay) }))
      .filter(o => o.touchProb !== null && o.touchProb <= touchThreshold)
      .sort((a,b) => b.absDist - a.absDist);
    if (!scored.length) {
      return {
        ok: false,
        reason: `All premium-viable strikes have touch probability > ${(touchThreshold*100).toFixed(0)}%. Market too volatile for this structure today.`,
        direction, sellSide, atmInfo, reqPremPerLot,
        candidates: viable.slice(0, 5).map(o => ({ ...o, touchProb: touchProbability(o.absDist, hv20.oneDay) })),
      };
    }
    const best = scored[0];
    const totalShortPremium = best.premium * shortLots;
    const netCredit = totalShortPremium - atmInfo.straddleCost;
    return {
      ok: true, direction, sellSide, sellSideLabel, atmInfo,
      shortStrike: best.strike,
      shortDistancePct: best.absDist,
      shortPremiumPerLot: best.premium,
      shortLots,
      totalShortPremium,
      straddleCost: atmInfo.straddleCost,
      netCredit,
      touchProb: best.touchProb,
      reqPremPerLot,
      regime,
      alternatives: scored.slice(1, 4),
    };
  }

  function buildFuturesPlan({
    price, direction, hv20, BGTC, funding,
    accountEquity = null, riskPct = 1,
    slTouchTarget = 0.35, tpTouchTarget = 0.20, minRR = 1.3,
  }) {
    if (!price || (direction !== 'long' && direction !== 'short')) {
      return {
        ok: false,
        reason: 'Missing price, or direction must be "long"/"short". Direction has to come from your own thesis — BGTC upside is not a validated directional signal (see docs/TRADE_FLOW.md).',
      };
    }

    const warnings = [];
    const curves = BGTC?.barrier_curves;
    let slPick, tpPick, usedBarrierCurves = false;

    if (curves?.up?.length && curves?.dn?.length) {
      usedBarrierCurves = true;
      const slSide = direction === 'long' ? curves.dn : curves.up;
      const tpSide = direction === 'long' ? curves.up : curves.dn;
      const closest = (arr, target) => arr.reduce((best, c) =>
        Math.abs(c.touch_prob - target) < Math.abs(best.touch_prob - target) ? c : best, arr[0]);
      slPick = closest(slSide, slTouchTarget);
      tpPick = closest(tpSide, tpTouchTarget);
    } else {
      warnings.push('barrier_curves not available in the BGTC payload — falling back to a plain HV20 multiple for SL/TP (less precise than the NOCTUA-calibrated version).');
      const oneDayMovePct = hv20?.oneDay || 2;
      slPick = { pct: oneDayMovePct * 1.0, touch_prob: null };
      tpPick = { pct: oneDayMovePct * 1.5, touch_prob: null };
    }

    const slDistPct = Math.abs(slPick.pct);
    const tpDistPct = Math.abs(tpPick.pct);
    const riskRewardRatio = slDistPct > 0 ? tpDistPct / slDistPct : null;

    if (riskRewardRatio !== null && riskRewardRatio < minRR) {
      warnings.push(`Risk/reward at these touch-probability targets is ${riskRewardRatio.toFixed(2)}, below your minimum of ${minRR}. Consider a further TP target or a tighter SL target.`);
    }

    const pVolAmplify = BGTC?.p_vol_amplify ?? (BGTC?.volAmp != null ? BGTC.volAmp / 100 : 0.5);
    const volSizeMult = Math.max(0.25, 1 - pVolAmplify * 0.6);

    let fundingSizeMult = 1;
    if (funding?.flag === 'long-extreme' && direction === 'long') {
      fundingSizeMult = 0.5;
      warnings.push(`Funding is extremely positive (${funding.ratePct?.toFixed?.(4)}%) while going long — crowded and expensive to hold.`);
    } else if (funding?.flag === 'short-extreme' && direction === 'short') {
      fundingSizeMult = 0.5;
      warnings.push(`Funding is extremely negative (${funding.ratePct?.toFixed?.(4)}%) while going short — crowded and expensive to hold.`);
    }

    const sizeMultiplier = Math.round(volSizeMult * fundingSizeMult * 100) / 100;

    const stopLoss = direction === 'long'
      ? price * (1 - slDistPct / 100)
      : price * (1 + slDistPct / 100);
    const takeProfit = direction === 'long'
      ? price * (1 + tpDistPct / 100)
      : price * (1 - tpDistPct / 100);

    let riskAmount = null, positionNotional = null;
    if (accountEquity && slDistPct > 0) {
      riskAmount = accountEquity * (riskPct / 100) * sizeMultiplier;
      positionNotional = riskAmount / (slDistPct / 100);
    }

    return {
      ok: true,
      direction,
      entryPrice: price,
      stopLoss: Math.round(stopLoss * 100) / 100,
      takeProfit: Math.round(takeProfit * 100) / 100,
      stopDistancePct: Math.round(slDistPct * 100) / 100,
      tpDistancePct: Math.round(tpDistPct * 100) / 100,
      riskRewardRatio: riskRewardRatio !== null ? Math.round(riskRewardRatio * 100) / 100 : null,
      slTouchProb: slPick.touch_prob,
      tpTouchProb: tpPick.touch_prob,
      usedBarrierCurves,
      horizonHours: BGTC?.H_hours || 19,
      pVolAmplify,
      sizeMultiplier,
      riskAmount,
      positionNotional,
      warnings,
      note: 'SL/TP/sizing are derived from validated NOCTUA outputs (p_vol_amplify, barrier_curves) plus funding. This function does not derive direction — you supply it.',
    };
  }

  function computeSentiment(news, BGTC, fg, regime) {
    const items = news?.items || [];
    const newsPos = items.filter(i => i.sent === 'pos').length;
    const newsNeg = items.filter(i => i.sent === 'neg').length;
    const newsNeu = items.filter(i => i.sent === 'neu').length;
    const newsScore = items.length
      ? Math.round((newsPos / Math.max(1, newsPos + newsNeg + newsNeu)) * 100)
      : 40;
    const BGTCScore   = BGTC?.upside || 50;
    const fgScore     = fg?.value || 50;
    const volAmpScore = BGTC?.volAmp || 50;
    const regimePenalty = regime?.regime === 'red'        ? 20
                        : regime?.regime === 'amber-dark' ? 10
                        : regime?.regime === 'amber'      ? 5 : 0;
    const composite = Math.round(
      BGTCScore * 0.35 + fgScore * 0.25 + newsScore * 0.25 +
      (100 - volAmpScore) * 0.15 - regimePenalty
    );
    return {
      composite: Math.max(0, Math.min(100, composite)),
      newsScore, BGTCScore, fgScore, volAmpScore,
      newsPos, newsNeg, total: items.length,
    };
  }

  function buildDecision({ price, hv20, regime, BGTC, retailPlan, session, funding, sentiment }) {
    const reasons = [];
    const blockers = [];

    if (!regime?.allowTrade) {
      blockers.push(`IV/HV20 = ${regime?.ratio?.toFixed(2) || '?'} (${regime?.label}) — PDF rule: no short premium above 1.8`);
    } else {
      reasons.push(`IV/HV20 = ${regime.ratio.toFixed(2)} — ${regime.label} (sizing: ${(regime.sizing*100).toFixed(0)}%)`);
    }

    if (session?.tier === 'skip') {
      blockers.push(`Session: ${session.phase} — avoid new entries now`);
    } else if (session?.tier === 'best') {
      reasons.push(`Session: ${session.phase} — (ideal)`);
    } else {
      reasons.push(`Session: ${session?.phase || '—'}`);
    }

    if (funding?.flag === 'long-extreme' || funding?.flag === 'short-extreme') {
      blockers.push(`Perp funding extreme (${funding.ratePct.toFixed(4)}%) — crowd positioning risk`);
    } else if (funding) {
      reasons.push(`Funding: ${funding.ratePct.toFixed(4)}% (${funding.flag})`);
    }

    if (BGTC?.freshness === 'very-stale') {
      blockers.push(`BGTC last updated >${BGTC.ageHrs?.toFixed(0)}h ago — signal stale`);
    } else if (BGTC) {
      reasons.push(`BGTC: ${BGTC.upside.toFixed(1)}% upside / ${BGTC.volAmp.toFixed(1)}% vol-amp (${BGTC.freshness})`);
    }

    if (BGTC && Math.abs(BGTC.upside - 50) < 5) {
      blockers.push(`BGTC ${BGTC.upside.toFixed(1)}% — 50/50 — no directional edge for asymmetric wing`);
    }

    const canTrade = retailPlan?.ok === true;

    let verdict, verdictClass;
    if (blockers.length >= 2) {
      verdict = 'NO-TRADE'; verdictClass = 'nt';
    } else if (blockers.length === 1) {
      verdict = canTrade ? 'CAUTION' : 'NO-TRADE';
      verdictClass = canTrade ? 'cau' : 'nt';
    } else {
      verdict = canTrade ? 'TRADE OK' : 'WAIT';
      verdictClass = canTrade ? 'go' : 'cau';
    }

    const confidence = Math.max(0, Math.min(100,
      100 - blockers.length * 25 - (BGTC?.freshness === 'stale' ? 10 : 0)
      + (regime?.sizing || 0) * 30
      - (BGTC ? Math.abs(50 - BGTC.upside) < 5 ? 15 : 0 : 15)
    ));

    return {
      verdict, verdictClass, confidence,
      reasons, blockers,
      canTrade,
      direction: BGTC?.upside >= 55 ? 'bullish' : BGTC?.upside <= 45 ? 'bearish' : 'neutral',
      tradeStructure: canTrade && retailPlan.ok
        ? `1x long $${retailPlan.atmInfo.atmStrike} straddle + ${retailPlan.shortLots}x short $${retailPlan.shortStrike} ${retailPlan.sellSide}`
        : null,
    };
  }

  return {
    fetchPrice, fetchHourly, fetchDaily, fetchFearGreed,
    fetchOptions, fetchBGTC, fetchNewsSentiment, fetchFunding,
    computeHV20, computeHV20Series, computeATR7,
    findAtmIv, computeRanger, classifyRegime,
    touchProbability, buildRetailPlan, buildFuturesPlan, computeSentiment,
    nextDayMoveOdds, computeSessionContext, buildDecision,
  };
})();
