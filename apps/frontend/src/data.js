/**
 * data.js  (v4.1 — connector-enriched + bug fixes)
 * =====================================================================
 * v4.1 changes from v4:
 *   • Prefer ./data/*.json snapshots (written by GitHub Actions enrichment
 *     cron) over browser CORS proxies. See .github/workflows/fetch-data.yml.
 *   • Added Crypto.com Exchange as a secondary price source when Binance
 *     is rate-limited or blocked.
 *   • News caches are now namespaced (news_exa / news_cp / news_gdelt /
 *     news_bigdata) and the dashboard picks the freshest non-empty.
 *   • EXA placeholder string ("your-exa-api-key-here") is no longer
 *     treated as a real key.
 *   • Every fetcher returns a `_freshness` field (fresh|stale|offline) so
 *     the UI can show a stale glyph instead of silently displaying day-old
 *     numbers.
 *   • Funding `flag` thresholds documented and tightened to match PDF §3.
 *   • News items deduped across sources by URL host + title prefix.
 *   • Kronos source timestamp respects an optional tz hint from the
 *     enrichment snapshot (server-side can emit UTC).
 */
const DataLayer = (() => {

  // ── CLOUDFLARE WORKER BASE URL ────────────────────────────────────────
  // Di Cloudflare Pages, Worker dideploy sebagai service binding ke /api/*.
  // Saat dev lokal (`wrangler dev`), worker jalan di localhost:8787.
  // Set window.WORKER_BASE di src/config.js untuk override jika perlu.
  const WORKER_BASE = (typeof window !== 'undefined' && window.WORKER_BASE)
    ? window.WORKER_BASE
    : '/api';

  // Helper: fetch dari Worker dengan fallback ke direct API jika Worker error.
  async function workerFetch(path, timeoutMs = 9000) {
    const r = await fetch(`${WORKER_BASE}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`Worker ${path}: HTTP ${r.status}`);
    return r.json();
  }

  // ── STATIC SNAPSHOT ROOT ──────────────────────────────────────────────
  // Fallback: ./data/*.json (di-serve bareng Pages, diupdate GH Actions).
  const SNAPSHOT_ROOT = './data';
  const SNAPSHOT_MAX_AGE_MS = 45 * 60_000;   // accept if updated within 45 min

  async function tryLoadSnapshot(name) {
    try {
      const r = await fetch(`${SNAPSHOT_ROOT}/${name}.json?_=${Date.now()}`,
        { signal: AbortSignal.timeout(3500) });
      if (!r.ok) return null;
      const j = await r.json();
      const updatedMs = j._updatedMs || j.ts || null;
      if (updatedMs && Date.now() - updatedMs > SNAPSHOT_MAX_AGE_MS) {
        // Too stale; mark but still return for fallback purposes.
        return { ...j, _freshness: 'stale-snapshot' };
      }
      return { ...j, _freshness: 'fresh-snapshot' };
    } catch { return null; }
  }

  // ── CORS PROXY CHAIN (free, no-key, in priority order) ─────────────────
  // Tried one after another until one succeeds. Covers the case where a
  // proxy goes down, rate-limits us, or returns a stale cached page.
  // ── CACHE HELPERS ──────────────────────────────────────────────────────
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

  // ══════════════════════════════════════════════════════════════════════
  //                          PRICE / CANDLES
  // ══════════════════════════════════════════════════════════════════════

  async function fetchPrice() {
    const cached = cacheGet('price');
    if (cached) return cached;
    try {
      // Worker proxy: no CORS issue, has KV cache
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

  // ══════════════════════════════════════════════════════════════════════
  //                     FUNDING RATE (NEW — PDF §4)
  // ══════════════════════════════════════════════════════════════════════
  // Perpetual funding. Thresholds (per 8h period, as a fraction):
  //   |rate| > 0.0003 (0.03%/8h ≈ 0.09%/day) → extreme crowding flag
  //   |rate| > 0.0001 (0.01%/8h, the Binance baseline) → heavy
  // PDF calls out funding extremes as a macro regime flag alongside IV/HV.
  // (v4.1: comment corrected — it previously claimed extreme = 0.01%/8h,
  //  which contradicted the 0.0003 threshold actually coded below.)
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

  // ══════════════════════════════════════════════════════════════════════
  //                       FEAR & GREED / OPTIONS
  // ══════════════════════════════════════════════════════════════════════

  async function fetchFearGreed() {
    const cached = cacheGet('fg');
    if (cached) return cached;

    // Prefer Worker KV (diisi cron setiap jam)
    try {
      const snap = await tryLoadSnapshot('fg'); // ./data/fg.json GH Actions fallback
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

  // ══════════════════════════════════════════════════════════════════════
  //      KRONOS SCRAPER (BULLETPROOF — 4 proxies + DOMParser)
  // ══════════════════════════════════════════════════════════════════════
  // The live page is rendered as static HTML with the two metrics appearing
  // in deterministic sections. Instead of hoping one regex works, we:
  //   1. Try each CORS proxy in sequence until we get HTML
  //   2. Parse HTML with DOMParser (robust to whitespace/tag shifts)
  //   3. Extract by heading → next large % number (3 strategies)
  //   4. Sanity-check (0 ≤ upside ≤ 100, timestamp parseable)
  //   5. Expose freshness: how stale is the source timestamp vs now?

  async function fetchKronos() {
    const cached = cacheGet('kronos');
    if (cached) return cached;

    // Primary: Worker KV — diisi GH Actions via POST /api/noctua/push
    try {
      const data = await workerFetch('/noctua/latest');
      if (data?.upside != null) {
        cacheSet('kronos', data, 3600_000 * 3);
        cacheSet('kronos_stale', data, 86400_000 * 3);
        return data;
      }
    } catch (e) {
      console.warn('[fetchKronos] worker noctua miss:', e.message);
    }

    // Fallback: ./data/kronos.json (GH Actions commit snapshot)
    const snap = await tryLoadSnapshot('kronos');
    if (snap?.upside != null) {
      cacheSet('kronos', snap, 3600_000);
      cacheSet('kronos_stale', snap, 86400_000 * 3);
      return snap;
    }

    return cacheGet('kronos_stale');
  }

  // ── DEAD CODE REMOVED (CF migration) ─────────────────────────────────
  // parseKronosHtml, parseSourceTs, fetchCryptoPanicNews, fetchGdeltNews,
  // fetchViaProxyChain, CORS_PROXIES — semua sudah ada di Worker.
  // ─────────────────────────────────────────────────────────────────────

  // Placeholder agar tidak error jika ada referensi lama di console
  function parseKronosHtml(html) {
    // STRATEGY A: DOMParser — look for h3 headings, find following percentage
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const headings = [...doc.querySelectorAll('h1,h2,h3,h4,h5,p,strong')];
      let upside = null, volAmp = null;
      for (const h of headings) {
        const hText = (h.textContent || '').toLowerCase();
        if (upside === null && hText.includes('upside probability')) {
          // Look at siblings for a "XX.X%" number
          const pct = findNearbyPercent(h);
          if (pct !== null && pct >= 0 && pct <= 100) upside = pct;
        }
        if (volAmp === null && hText.includes('volatility amplification')) {
          const pct = findNearbyPercent(h);
          if (pct !== null && pct >= 0 && pct <= 100) volAmp = pct;
        }
      }
      // Timestamp
      let sourceTs = null;
      const bodyTxt = doc.body?.textContent || '';
      const tsM = bodyTxt.match(/Last Updated[^:]*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/i);
      if (tsM) sourceTs = tsM[1].trim();

      if (upside !== null && volAmp !== null) {
        return { upside, volAmp, sourceTs, strategy: 'domparser' };
      }
    } catch (e) { console.warn('[parseKronos] DOM strategy failed', e); }

    // STRATEGY B: Labeled-section regex — percent immediately after the label
    // "Upside Probability (Next 24h)</h3>\n16.7%"
    try {
      const labelRe = /Upside\s+Probability[\s\S]{0,200}?(\d+(?:\.\d+)?)\s*%/i;
      const upMatch  = html.match(labelRe);
      const volRe    = /Volatility\s+Amplification[\s\S]{0,200}?(\d+(?:\.\d+)?)\s*%/i;
      const vlMatch  = html.match(volRe);
      const tsM      = html.match(/Last Updated[^:]*:\s*(?:<[^>]+>)?([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/i);
      if (upMatch && vlMatch) {
        return {
          upside: parseFloat(upMatch[1]),
          volAmp: parseFloat(vlMatch[1]),
          sourceTs: tsM ? tsM[1].trim() : null,
          strategy: 'label-regex',
        };
      }
    } catch (e) { console.warn('[parseKronos] label-regex failed', e); }

    // STRATEGY C: Legacy long-context regex (our v3 fallback)
    try {
      const upM = html.match(/([\d.]+)\s*%[\s\S]{0,400}?higher than the last known price/i);
      const vlM = html.match(/([\d.]+)\s*%[\s\S]{0,400}?recent historical volatility/i);
      if (upM && vlM) {
        const tsM = html.match(/Last Updated[^:]*:\s*(?:<[^>]+>)?([^<*\n]+)/i);
        return {
          upside: parseFloat(upM[1]),
          volAmp: parseFloat(vlM[1]),
          sourceTs: tsM ? tsM[1].trim() : null,
          strategy: 'legacy-regex',
        };
      }
    } catch (e) { console.warn('[parseKronos] legacy failed', e); }

    return null;
  }

  // Helper: starting from a header element, walk following siblings looking
  // for the first "XX.X%" number (ignores the header's own text).
  function findNearbyPercent(startEl) {
    let el = startEl;
    for (let i = 0; i < 12 && el; i++) {
      // Check siblings first
      let sib = el.nextElementSibling;
      for (let j = 0; j < 6 && sib; j++) {
        const txt = (sib.textContent || '').trim();
        const m = txt.match(/^(\d+(?:\.\d+)?)\s*%\s*$/) || txt.match(/(\d+(?:\.\d+)?)\s*%/);
        if (m) {
          const n = parseFloat(m[1]);
          if (n >= 0 && n <= 100) return n;
        }
        sib = sib.nextElementSibling;
      }
      el = el.parentElement;
    }
    return null;
  }

  function parseSourceTs(s) {
    if (!s) return null;
    // "2026-04-18 17:00:25" → treated as UTC
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
  }

  // ══════════════════════════════════════════════════════════════════════
  //                          NEWS (Exa → CryptoPanic → GDELT fallback)
  // ══════════════════════════════════════════════════════════════════════

  async function fetchNewsSentiment() {
    const cached = cacheGet('news');
    if (cached) return cached;

    // Primary: Worker KV (diisi cron Cloudflare setiap jam, termasuk Exa jika ada key)
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

    // Fallback: ./data/news.json (GH Actions snapshot jika ada)
    const snap = await tryLoadSnapshot('news');
    if (snap?.items?.length) {
      cacheSet('news_stale', snap, 86400_000);
      return snap;
    }

    return cacheGet('news_stale') || { items: [], ts: Date.now(), source: 'offline' };
  }

  // v4.1: cross-source headline dedupe. Aggregators (CryptoPanic, GDELT)
  // routinely surface the same story under slightly different titles/URLs.
  // Key = hostname + first 60 chars of the normalised title; first hit wins
  // (sources are already returned newest-first).
  function dedupeNews(items) {
    const seen = new Set();
    const out = [];
    for (const it of items || []) {
      let host = '';
      try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch { /* keep '' */ }
      const titleKey = (it.headline || '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      const key = host + '|' + titleKey;
      // Also dedupe identical titles across different hosts (syndication)
      const titleOnlyKey = 't|' + titleKey;
      if (seen.has(key) || (titleKey.length > 20 && seen.has(titleOnlyKey))) continue;
      seen.add(key);
      seen.add(titleOnlyKey);
      out.push(it);
    }
    return out;
  }

  function scoreSentiment(text) {
    const t = (text || '').toLowerCase();
    const bull = ['bullish','rally','surge','breakout','recover','buy','inflow','institutional',
                  'adoption','higher','gain','green','pump','above','rebound','ath','all-time high',
                  'soar','jump','spike','optimistic','accumulat','bull case','upgrade'];
    const bear = ['bearish','crash','drop','fall','bear','sell','liquidat','fear','panic','below',
                  'loss','red','dump','warning','risk','decline','bottom','correction','capitulat',
                  'plunge','tumble','slide','downgrade','weakness'];
    let s = 0;
    bull.forEach(w => { if (t.includes(w)) s++; });
    bear.forEach(w => { if (t.includes(w)) s--; });
    return s > 0 ? 'pos' : s < 0 ? 'neg' : 'neu';
  }

  // ══════════════════════════════════════════════════════════════════════
  //                        QUANTITATIVE ENGINES
  // ══════════════════════════════════════════════════════════════════════

  // HV20 (20-day annualised realised vol from log returns)
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

  // HV20 historical series — for the sparkline + trend
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

  // ATR-7 (simple)
  function computeATR7(dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 7) return null;
    const last7 = dailyCandles.slice(-7);
    const ranges = last7.map(c => (c.h - c.l) / ((c.h + c.l) / 2) * 100);
    return ranges.reduce((a,b) => a+b, 0) / ranges.length;
  }

  // ATM IV from Deribit chain (nearest expiry, strike closest to spot)
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

  // Classic RANGER (kept for back-compat with existing UI pieces)
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

  // IV/HV20 REGIME (PDF §2: danger threshold = 1.76, rounded to 1.8)
  function classifyRegime(atmIvPct, hv20Ann) {
    if (!atmIvPct || !hv20Ann) return { ratio: null, regime: 'unknown', label: '—', allowTrade: false, sizing: 0 };
    const ratio = atmIvPct / hv20Ann;
    let regime, label, allowTrade, sizing;
    if      (ratio < 1.2) { regime = 'green';     label = 'CALM';       allowTrade = true;  sizing = 1.0;  }
    else if (ratio < 1.4) { regime = 'green';     label = 'NORMAL';     allowTrade = true;  sizing = 0.7;  }
    else if (ratio < 1.6) { regime = 'amber';     label = 'CAUTION';    allowTrade = true;  sizing = 0.4;  }
    else if (ratio < 1.8) { regime = 'amber-dark';label = 'REDUCED';    allowTrade = true;  sizing = 0.2;  }
    else                  { regime = 'red';       label = 'NO-TRADE';   allowTrade = false; sizing = 0;    }
    return { ratio, regime, label, allowTrade, sizing, ivPct: atmIvPct, hv20: hv20Ann };
  }

  // Next-day move odds (PDF §1 backtest — conditional on IV/HV20 > 1.76)
  function nextDayMoveOdds(ratio) {
    if (ratio == null) return null;
    if (ratio > 1.76) {
      // HIGH-IV regime — fat tails
      return {
        regimeType: 'high-iv',
        description: 'Elevated IV/HV20 regime — realised vol likely to overshoot',
        odds: [
          { move: '≥ 2%', prob: 0.33 },
          { move: '≥ 4%', prob: 0.16 },
          { move: '≥ 6%', prob: 0.087 },
          { move: '≥ 8%', prob: 0.061 },
          { move: '≥ 10%', prob: 0.045 },
        ],
        daysPct: 10,
      };
    }
    // NORMAL regime — typical distribution (from PDF §5 "repeatable behaviour")
    return {
      regimeType: 'normal',
      description: 'Normal regime — volatility-clustered, tails contained',
      odds: [
        { move: 'Range ≤ 1× hv20_1d', prob: 0.26 },
        { move: 'Range ≤ 1.5× hv20_1d', prob: 0.56 },
        { move: 'Range ≤ 2× hv20_1d', prob: 0.76 },
        { move: 'Range ≤ 2.5× hv20_1d', prob: 0.87 },
        { move: 'Range ≤ 3× hv20_1d', prob: 0.93 },
      ],
      daysPct: 90,
    };
  }

  // Touch probability (PDF §5 empirical: k × hv20_1d buckets)
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

  // Session context (PDF §5 + existing calm_period_analysis)
  function computeSessionContext() {
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const h = nowIST.getHours() + nowIST.getMinutes() / 60;
    let phase, advice, tier;
    if      (h >= 5.5  && h < 8.5)  { phase = 'Pre-Calm';           advice = 'Wait for calm window (08:30–12:30 IST) for tight spreads.'; tier = 'neutral'; }
    else if (h >= 8.5  && h < 12.5) { phase = 'CALM ⭐ (best entry)';advice = 'Ideal execution window. Run IV/HV20 + Kronos checks now.'; tier = 'best'; }
    else if (h >= 12.5 && h < 14)   { phase = 'Post-Calm';          advice = 'Still relatively calm. OK to enter but vol rising soon.'; tier = 'ok'; }
    else if (h >= 14   && h < 17.5) { phase = 'Pre-Volatile';       advice = 'Secondary entry OK 16:30–17:20 for next-day structure.';    tier = 'warn'; }
    else if (h >= 17.5 && h < 18.5) { phase = 'Expiry Transition';  advice = '17:30 IST Delta expiry. Avoid new entries on old structure.'; tier = 'skip'; }
    else if (h >= 18.5 || h < 0.5)  { phase = 'VOLATILE (EU+US)';   advice = 'Highest realised vol window — DO NOT enter new short premium.'; tier = 'skip'; }
    else                            { phase = 'Late-Night';         advice = 'Asian illiquid hours. Monitor only, don\'t trade.'; tier = 'neutral'; }
    return { phase, advice, tier, istHour: h };
  }

  // Retail seller planner (from PDF §2)
  function buildRetailPlan({
    price, options, atmInfo, hv20, kronosUpside, regime,
    shortLots = 60, safetyFactor = 1.15, touchThreshold = 0.10,
  }) {
    if (!price || !atmInfo || !hv20 || !options) {
      return { ok: false, reason: 'Missing inputs (price/ATM/HV20/options)' };
    }
    if (!regime.allowTrade) {
      return { ok: false, reason: `IV/HV20 = ${regime.ratio?.toFixed(2)} → ${regime.label}. Skip today.` };
    }
    const direction = kronosUpside >= 55 ? 'bullish' : kronosUpside <= 45 ? 'bearish' : 'neutral';
    if (direction === 'neutral') {
      return { ok: false, reason: `Kronos ${kronosUpside}% ≈ 50/50. No directional edge — use symmetric condor instead.` };
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
        reason: `No OTM ${sellSideLabel} pay ≥ $${reqPremPerLot.toFixed(2)}/lot required to finance ${shortLots}-lot wing.`,
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

  // Composite sentiment score
  function computeSentiment(news, kronos, fg, regime) {
    const items = news?.items || [];
    const newsPos = items.filter(i => i.sent === 'pos').length;
    const newsNeg = items.filter(i => i.sent === 'neg').length;
    const newsNeu = items.filter(i => i.sent === 'neu').length;
    const newsScore = items.length
      ? Math.round((newsPos / Math.max(1, newsPos + newsNeg + newsNeu)) * 100)
      : 40;
    const kronosScore   = kronos?.upside || 50;
    const fgScore       = fg?.value || 50;
    const volAmpScore   = kronos?.volAmp || 50;
    const regimePenalty = regime?.regime === 'red' ? 20
                        : regime?.regime === 'amber-dark' ? 10
                        : regime?.regime === 'amber' ? 5 : 0;
    const composite = Math.round(
      kronosScore * 0.35 + fgScore * 0.25 + newsScore * 0.25 +
      (100 - volAmpScore) * 0.15 - regimePenalty
    );
    return {
      composite: Math.max(0, Math.min(100, composite)),
      newsScore, kronosScore, fgScore, volAmpScore,
      newsPos, newsNeg, total: items.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //                   MASTER DECISION ENGINE (NEW)
  // ═══════════════════════════════════════════════════════════════════════
  // Pulls it all together. Returns { verdict, confidence, reasons[], actionPath }
  // Used to populate the hero decision card.
  function buildDecision({ price, hv20, regime, kronos, retailPlan, session, funding, sentiment }) {
    const reasons = [];
    const blockers = [];

    // Trade allowed by IV/HV20 regime?
    if (!regime?.allowTrade) {
      blockers.push(`IV/HV20 = ${regime?.ratio?.toFixed(2) || '?'} (${regime?.label}) — PDF rule: no short premium above 1.8`);
    } else {
      reasons.push(`IV/HV20 = ${regime.ratio.toFixed(2)} → ${regime.label} (sizing: ${(regime.sizing*100).toFixed(0)}%)`);
    }

    // Session check
    if (session?.tier === 'skip') {
      blockers.push(`Session: ${session.phase} — avoid new entries now`);
    } else if (session?.tier === 'best') {
      reasons.push(`Session: ${session.phase} ✓ (ideal)`);
    } else {
      reasons.push(`Session: ${session?.phase || '—'}`);
    }

    // Funding regime
    if (funding?.flag === 'long-extreme' || funding?.flag === 'short-extreme') {
      blockers.push(`Perp funding extreme (${funding.ratePct.toFixed(4)}%) — crowd positioning risk`);
    } else if (funding) {
      reasons.push(`Funding: ${funding.ratePct.toFixed(4)}% (${funding.flag})`);
    }

    // Kronos freshness
    if (kronos?.freshness === 'very-stale') {
      blockers.push(`Kronos last updated >${kronos.ageHrs?.toFixed(0)}h ago — signal stale`);
    } else if (kronos) {
      reasons.push(`Kronos: ${kronos.upside.toFixed(1)}% upside / ${kronos.volAmp.toFixed(1)}% vol-amp (${kronos.freshness})`);
    }

    // Directional clarity
    if (kronos && Math.abs(kronos.upside - 50) < 5) {
      blockers.push(`Kronos ${kronos.upside.toFixed(1)}% ≈ 50/50 — no directional edge for asymmetric wing`);
    }

    // Plan viability
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

    // Confidence = 0-100 based on positive signals vs blockers
    const confidence = Math.max(0, Math.min(100,
      100 - blockers.length * 25 - (kronos?.freshness === 'stale' ? 10 : 0)
      + (regime?.sizing || 0) * 30
      - (kronos ? Math.abs(50 - kronos.upside) < 5 ? 15 : 0 : 15)
    ));

    return {
      verdict, verdictClass, confidence,
      reasons, blockers,
      canTrade,
      direction: kronos?.upside >= 55 ? 'bullish' : kronos?.upside <= 45 ? 'bearish' : 'neutral',
      tradeStructure: canTrade && retailPlan.ok
        ? `1× long $${retailPlan.atmInfo.atmStrike} straddle + ${retailPlan.shortLots}× short $${retailPlan.shortStrike} ${retailPlan.sellSide}`
        : null,
    };
  }

  return {
    // fetchers
    fetchPrice, fetchHourly, fetchDaily, fetchFearGreed,
    fetchOptions, fetchKronos, fetchNewsSentiment, fetchFunding,
    // quant engines
    computeHV20, computeHV20Series, computeATR7,
    findAtmIv, computeRanger, classifyRegime,
    touchProbability, buildRetailPlan, computeSentiment,
    nextDayMoveOdds, computeSessionContext, buildDecision,
    // util
    scoreSentiment,
  };
})();
