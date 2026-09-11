/**
 * routes/market.ts
 * -------------------------------------------------------------------
 * Server-side proxy untuk semua market data API yang di browser kena CORS.
 * Worker fetch langsung ke sumber, browser fetch ke /api/market/*.
 *
 * Cache KV keys (TTL sesuai kebutuhan):
 *   market:price    → 60 s
 *   market:hourly   → 5 menit
 *   market:daily    → 1 jam
 *   market:funding  → 10 menit
 *   market:options  → 10 menit
 *
 * v4.3: Binance mulai memblokir request dari IP Cloudflare Worker ke
 *   /api/v3/klines (451) dan fapi.binance.com/premiumIndex (403).
 *   Ticker spot (24hr) & Deribit masih OK. Ditambahkan fallback ke
 *   Bybit v5 public API untuk /daily dan /funding, mengikuti pola
 *   fallback yang sudah ada di /price (Binance -> Crypto.com).
 */

import { Hono } from 'hono';
import type { Env } from '../index';

export const marketRoutes = new Hono<{ Bindings: Env }>();

// ---- helpers ----

async function kvGet<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

async function kvPut(kv: KVNamespace, key: string, data: unknown, ttl: number): Promise<void> {
  await kv.put(key, JSON.stringify(data), { expirationTtl: ttl });
}

// ---- GET /api/market/price ----

marketRoutes.get('/price', async (c) => {
  const cached = await kvGet(c.env.BTC_CACHE, 'market:price');
  if (cached) return c.json(cached);

  // Primary: Binance
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
    const t = await r.json() as Record<string, string>;
    if (!t.lastPrice) throw new Error('No data');
    const data = {
      price: parseFloat(t.lastPrice),
      high: parseFloat(t.highPrice),
      low: parseFloat(t.lowPrice),
      change: parseFloat(t.priceChangePercent) / 100,
      vol: parseFloat(t.volume),
      volUsd: parseFloat(t.quoteVolume),
      ts: Date.now(),
      source: 'binance',
    };
    await kvPut(c.env.BTC_CACHE, 'market:price', data, 60);
    return c.json(data);
  } catch (e) {
    console.warn('[market/price] binance failed, trying crypto.com:', (e as Error).message);
  }

  // Fallback: Crypto.com
  try {
    const r = await fetch(
      'https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=BTCUSD-PERP',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`CryptoCom HTTP ${r.status}`);
    const j = await r.json() as { result?: { data?: Array<Record<string, string>> } };
    const t = j?.result?.data?.[0];
    if (!t || !t['a']) throw new Error('No ticker data');
    const data = {
      price: parseFloat(t['a']),
      high: parseFloat(t['h']),
      low: parseFloat(t['l']),
      change: isFinite(parseFloat(t['c'])) ? parseFloat(t['c']) : 0,
      vol: parseFloat(t['v']),
      volUsd: parseFloat(t['vv']),
      ts: Date.now(),
      source: 'crypto.com',
    };
    await kvPut(c.env.BTC_CACHE, 'market:price', data, 60);
    return c.json(data);
  } catch (e) {
    console.error('[market/price] both sources failed:', (e as Error).message);
    return c.json({ error: 'price unavailable' }, 503);
  }
});

// ---- GET /api/market/hourly ----

marketRoutes.get('/hourly', async (c) => {
  const cached = await kvGet(c.env.BTC_CACHE, 'market:hourly');
  if (cached) return c.json(cached);

  try {
    const r = await fetch(
      'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=48',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json() as Array<Array<string | number>>;
    const data = raw.map((k) => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
    }));
    await kvPut(c.env.BTC_CACHE, 'market:hourly', data, 300);
    return c.json(data);
  } catch (e) {
    console.warn('[market/hourly] binance failed, trying bybit:', (e as Error).message);
  }

  // Fallback: Bybit v5 (public, tidak diblokir dari Cloudflare)
  try {
    const r = await fetch(
      'https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=48',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
    const j = await r.json() as { result?: { list?: Array<Array<string>> } };
    const rows = j?.result?.list;
    if (!rows?.length) throw new Error('No kline data');
    // Bybit returns newest-first; reverse to oldest-first like Binance.
    const data = rows
      .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
      .reverse();
    await kvPut(c.env.BTC_CACHE, 'market:hourly', data, 300);
    return c.json(data);
  } catch (e) {
    console.error('[market/hourly] both sources failed:', (e as Error).message);
    return c.json({ error: 'hourly unavailable' }, 503);
  }
});

// ---- GET /api/market/daily ----

marketRoutes.get('/daily', async (c) => {
  const cached = await kvGet(c.env.BTC_CACHE, 'market:daily');
  if (cached) return c.json(cached);

  try {
    const r = await fetch(
      'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=60',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json() as Array<Array<string | number>>;
    const data = raw.map((k) => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
    }));
    await kvPut(c.env.BTC_CACHE, 'market:daily', data, 3600);
    return c.json(data);
  } catch (e) {
    console.warn('[market/daily] binance failed, trying bybit:', (e as Error).message);
  }

  // Fallback: Bybit v5 public kline (linear perp, daily interval)
  try {
    const r = await fetch(
      'https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=D&limit=60',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
    const j = await r.json() as { result?: { list?: Array<Array<string>> } };
    const rows = j?.result?.list;
    if (!rows?.length) throw new Error('No kline data');
    // Bybit returns newest-first; reverse to oldest-first (computeHV20 expects ascending).
    const data = rows
      .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
      .reverse();
    await kvPut(c.env.BTC_CACHE, 'market:daily', data, 3600);
    return c.json(data);
  } catch (e) {
    console.error('[market/daily] both sources failed:', (e as Error).message);
    return c.json({ error: 'daily unavailable' }, 503);
  }
});

// ---- GET /api/market/funding ----

marketRoutes.get('/funding', async (c) => {
  const cached = await kvGet(c.env.BTC_CACHE, 'market:funding');
  if (cached) return c.json(cached);

  try {
    const r = await fetch(
      'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { lastFundingRate?: string; markPrice?: string; nextFundingTime?: number };
    const rate = parseFloat(j.lastFundingRate ?? '0');
    const data = {
      rate,
      ratePct: rate * 100,
      annualizedPct: rate * 3 * 365 * 100,
      markPrice: parseFloat(j.markPrice ?? '0'),
      nextFundingMs: j.nextFundingTime,
      flag:
        Math.abs(rate) > 0.0003
          ? rate > 0 ? 'long-extreme' : 'short-extreme'
          : Math.abs(rate) > 0.0001
          ? rate > 0 ? 'long-heavy' : 'short-heavy'
          : 'neutral',
      ts: Date.now(),
      source: 'binance',
    };
    await kvPut(c.env.BTC_CACHE, 'market:funding', data, 600);
    return c.json(data);
  } catch (e) {
    console.warn('[market/funding] binance failed, trying bybit:', (e as Error).message);
  }

  // Fallback: Bybit v5 funding rate history (linear perp)
  try {
    const r = await fetch(
      'https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=1',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
    const j = await r.json() as { result?: { list?: Array<{ fundingRate: string; fundingRateTimestamp: string }> } };
    const row = j?.result?.list?.[0];
    if (!row) throw new Error('No funding data');
    const rate = parseFloat(row.fundingRate);

    // Bybit mark price via tickers endpoint (premiumIndex has no direct equivalent).
    let markPrice = 0;
    try {
      const mr = await fetch(
        'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT',
        { signal: AbortSignal.timeout(6000) },
      );
      const mj = await mr.json() as { result?: { list?: Array<{ markPrice?: string }> } };
      markPrice = parseFloat(mj?.result?.list?.[0]?.markPrice ?? '0');
    } catch { /* non-fatal, keep markPrice = 0 */ }

    const data = {
      rate,
      ratePct: rate * 100,
      annualizedPct: rate * 3 * 365 * 100,
      markPrice,
      nextFundingMs: null,
      flag:
        Math.abs(rate) > 0.0003
          ? rate > 0 ? 'long-extreme' : 'short-extreme'
          : Math.abs(rate) > 0.0001
          ? rate > 0 ? 'long-heavy' : 'short-heavy'
          : 'neutral',
      ts: Date.now(),
      source: 'bybit',
    };
    await kvPut(c.env.BTC_CACHE, 'market:funding', data, 600);
    return c.json(data);
  } catch (e) {
    console.error('[market/funding] both sources failed:', (e as Error).message);
    return c.json({ error: 'funding unavailable' }, 503);
  }
});

// ---- GET /api/market/options ----

marketRoutes.get('/options', async (c) => {
  const cached = await kvGet(c.env.BTC_CACHE, 'market:options');
  if (cached) return c.json(cached);

  try {
    const r = await fetch(
      'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
      { signal: AbortSignal.timeout(10000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { result?: Array<Record<string, unknown>> };
    const rows = j.result || [];
    const parsed = rows
      .map((row) => {
        const m = (row['instrument_name'] as string)?.match(/BTC-(\d{1,2}\w{3}\d{2})-(\d+)-([CP])/);
        if (!m) return null;
        return {
          name: row['instrument_name'],
          expiry: m[1],
          strike: parseInt(m[2]),
          type: m[3],
          oi: (row['open_interest'] as number) || 0,
          vol: (row['volume'] as number) || 0,
          mark: (row['mark_price'] as number) || 0,
          markIv: (row['mark_iv'] as number) || 0,
          bidIv: (row['bid_iv'] as number) || 0,
          askIv: (row['ask_iv'] as number) || 0,
          underlying: (row['underlying_price'] as number) || 0,
        };
      })
      .filter(Boolean);
    await kvPut(c.env.BTC_CACHE, 'market:options', parsed, 600);
    return c.json(parsed);
  } catch (e) {
    console.error('[market/options]', (e as Error).message);
    return c.json({ error: 'options unavailable' }, 503);
  }
});
