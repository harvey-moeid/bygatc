/**
 * routes/market.ts
 * -------------------------------------------------------------------
 * Server-side proxy untuk semua market data API yang di browser kena CORS.
 * Worker fetch langsung ke sumber, browser fetch ke /api/market/*.
 *
 * Cache KV keys (TTL sesuai kebutuhan):
 *   market:price     -  60 s
 *   market:hourly    -  5 menit
 *   market:daily     -  1 jam
 *   market:funding   -  10 menit
 *   market:options   -  10 menit
 *   market:options_stale  -  24 jam (fallback kalau Deribit gagal, lihat v4.4)
 *
 * v4.6: Tambahkan header `Cache-Control` di tiap response sukses, selaras
 *   dengan TTL KV di atas, supaya browser & Cloudflare edge cache ikut
 *   menahan beban saat endpoint ini dipanggil dari banyak web eksternal
 *   sekaligus -- bukan cuma di-cache di sisi Worker/KV. Response error
 *   (503) ditandai `no-store` supaya konsumen tidak menyimpan kegagalan
 *   sementara.
 *
 * v4.5: /market/hourly dan /market/daily kena blokir dari DUA sisi sekaligus
 *   -- Binance balas 451 (restricted location) dan fallback Bybit yang
 *   ditambahkan di v4.3 kini ikut diblokir CloudFront (403) dari region
 *   Worker ini, jadi kombinasi Binance+Bybit bisa gagal berbarengan untuk
 *   kedua route. Ditambahkan fallback ketiga ke Crypto.com
 *   `public/get-candlestick` -- endpoint yang sama yang sudah dipakai
 *   sebagai fallback harga di /price, jadi tidak menambah dependency baru
 *   -- supaya kedua route tidak 503 total saat kedua exchange itu
 *   geo-block bersamaan. Data diurutkan ulang berdasarkan `t` (bukan
 *   diasumsikan sudah ascending) karena urutan array Crypto.com tidak
 *   didokumentasikan secara eksplisit.
 *
 * v4.4: /market/options adalah satu-satunya route di file ini yang tidak
 *   punya fallback sama sekali -- semua route lain sudah failover ke
 *   exchange kedua (lihat catatan v4.3 di bawah), tapi options 100%
 *   bergantung ke satu live call Deribit. Kalau Deribit timeout/rate-limit/
 *   ubah format instrument_name, route langsung 503 kosong -> frontend
 *   (findAtmIv -> classifyRegime) melihat ratio: null -> "IV/HV20 = ?
 *   (undefined)" -> paksa NO-TRADE walau sinyal lain bagus. Ditambahkan
 *   KV terpisah `market:options_stale` (TTL 24 jam) yang ditulis tiap kali
 *   fetch sukses, dan dibaca sebagai jalan terakhir sebelum balikin 503.
 *   0 baris ke-parse (regex instrument_name berhenti match) juga dianggap
 *   gagal supaya ikut lewat jalur fallback yang sama, bukan diam-diam
 *   nge-cache array kosong selama 10 menit.
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
  if (cached) {
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(cached);
  }

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
    c.header('Cache-Control', 'public, max-age=60');
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
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(data);
  } catch (e) {
    console.error('[market/price] both sources failed:', (e as Error).message);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'price unavailable' }, 503);
  }
});

// ---- GET /api/market/hourly ----

marketRoutes.get('/hourly', async (c) => {
  const cached = await kvGet(c.env.BTC_CACHE, 'market:hourly');
  if (cached) {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(cached);
  }

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
    c.header('Cache-Control', 'public, max-age=300');
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
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(data);
  } catch (e) {
    console.warn('[market/hourly] bybit failed, trying crypto.com:', (e as Error).message);
  }

  // Fallback 2: Crypto.com Exchange public candlestick -- tidak diblokir
  // secara geografis dari Cloudflare Worker (lihat catatan v4.5 di atas).
  // Endpoint yang sama sudah dipakai sebagai fallback harga di /price.
  try {
    const r = await fetch(
      'https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=BTCUSD-PERP&timeframe=1h&count=48',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`CryptoCom HTTP ${r.status}`);
    const j = await r.json() as {
      result?: { data?: Array<{ t: number; o: string; h: string; l: string; c: string; v: string }> };
    };
    const rows = j?.result?.data;
    if (!rows?.length) throw new Error('No candlestick data');
    // Urutan array tidak didokumentasikan resmi oleh Crypto.com, jadi sort
    // eksplisit ascending by `t` -- jangan asumsikan oldest-first seperti
    // Binance.
    const data = rows
      .map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }))
      .sort((a, b) => a.t - b.t);
    await kvPut(c.env.BTC_CACHE, 'market:hourly', data, 300);
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(data);
  } catch (e) {
    console.error('[market/hourly] all sources failed:', (e as Error).message);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'hourly unavailable' }, 503);
  }
});

// ---- GET /api/market/daily ----

marketRoutes.get('/daily', async (c) => {
  const cached = await kvGet(c.env.BTC_CACHE, 'market:daily');
  if (cached) {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(cached);
  }

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
    c.header('Cache-Control', 'public, max-age=3600');
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
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(data);
  } catch (e) {
    console.warn('[market/daily] bybit failed, trying crypto.com:', (e as Error).message);
  }

  // Fallback 2: Crypto.com Exchange public candlestick -- tidak diblokir
  // secara geografis dari Cloudflare Worker (lihat catatan v4.5 di atas).
  // Endpoint yang sama sudah dipakai sebagai fallback harga di /price dan
  // sebagai fallback kedua di /hourly.
  try {
    const r = await fetch(
      'https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=BTCUSD-PERP&timeframe=1D&count=60',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`CryptoCom HTTP ${r.status}`);
    const j = await r.json() as {
      result?: { data?: Array<{ t: number; o: string; h: string; l: string; c: string; v: string }> };
    };
    const rows = j?.result?.data;
    if (!rows?.length) throw new Error('No candlestick data');
    // Urutan array tidak didokumentasikan resmi oleh Crypto.com, jadi sort
    // eksplisit ascending by `t` -- jangan asumsikan oldest-first seperti
    // Binance.
    const data = rows
      .map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }))
      .sort((a, b) => a.t - b.t);
    await kvPut(c.env.BTC_CACHE, 'market:daily', data, 3600);
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(data);
  } catch (e) {
    console.error('[market/daily] all sources failed:', (e as Error).message);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'daily unavailable' }, 503);
  }
});

// ---- GET /api/market/funding ----

marketRoutes.get('/funding', async (c) => {
  const cached = await kvGet(c.env.BTC_CACHE, 'market:funding');
  if (cached) {
    c.header('Cache-Control', 'public, max-age=600');
    return c.json(cached);
  }

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
    c.header('Cache-Control', 'public, max-age=600');
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
    c.header('Cache-Control', 'public, max-age=600');
    return c.json(data);
  } catch (e) {
    console.error('[market/funding] both sources failed:', (e as Error).message);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'funding unavailable' }, 503);
  }
});

// ---- GET /api/market/options ----

marketRoutes.get('/options', async (c) => {
  const cached = await kvGet<Array<Record<string, unknown>>>(c.env.BTC_CACHE, 'market:options');
  if (cached) {
    c.header('Cache-Control', 'public, max-age=600');
    return c.json(cached);
  }

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

    // Deribit responding 200 with a body that no longer matches our
    // instrument_name regex (e.g. an API format change) is functionally
    // the same failure mode as a timeout -- treat it as one so it falls
    // through to the stale-cache path below instead of silently caching
    // an empty array for 10 minutes.
    if (!parsed.length) throw new Error('Deribit returned 0 parseable option rows');

    await kvPut(c.env.BTC_CACHE, 'market:options', parsed, 600);
    // Long-TTL copy used only as a last-resort fallback below. Written on
    // every successful fetch so it's always close to the last known-good
    // book, unlike the 10-min primary key.
    await kvPut(c.env.BTC_CACHE, 'market:options_stale', parsed, 86400);
    c.header('Cache-Control', 'public, max-age=600');
    return c.json(parsed);
  } catch (e) {
    console.error('[market/options] deribit failed, trying stale cache:', (e as Error).message);
    const stale = await kvGet<Array<Record<string, unknown>>>(c.env.BTC_CACHE, 'market:options_stale');
    if (stale?.length) {
      // Signal via header, not body -- findAtmIv() on the frontend expects
      // a plain array with .length, so the response shape stays identical
      // whether it's live or stale. Consumers that care can check the header.
      c.header('X-Data-Freshness', 'stale');
      // Short max-age on purpose -- this is already known-stale data, don't
      // let downstream caches hold onto it longer than the live TTL would.
      c.header('Cache-Control', 'public, max-age=60');
      return c.json(stale);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'options unavailable' }, 503);
  }
});
