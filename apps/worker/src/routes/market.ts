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
 *   market:candles:<symbol>:<tf>  -  lihat TF_CACHE_TTL (v4.8)
 *
 * v4.8: Tambah GET /market/candles?symbol=&tf= -- endpoint generik multi
 *   timeframe (m5, m15, h1, d1) dan multi simbol:
 *     - BTCUSDT     -> spot BTC/USDT (Binance -> Bybit spot -> OKX spot)
 *     - BTCUSDT.P   -> perpetual futures BTC (Binance futures -> Bybit
 *                      linear -> OKX SWAP)
 *     - XAUUSD      -> PROXY emas lewat PAXGUSDT (PAX Gold, token yang
 *                      di-backing 1:1 oleh emas fisik dan tracking harga
 *                      spot emas dengan dekat). Bukan harga forex XAUUSD
 *                      resmi -- tidak ada exchange crypto yang punya data
 *                      forex gratis tanpa API key berbayar (Twelve Data,
 *                      Alpha Vantage, dll). Field `source` di response
 *                      selalu menunjukkan exchange mana yang dipakai
 *                      (mis. "binance" untuk PAXGUSDT), supaya jelas ini
 *                      proxy, bukan harga XAUUSD dari sumber forex.
 *   /hourly dan /daily (BTCUSDT spot only, TIDAK diubah) tetap dipertahankan
 *   apa adanya untuk konsumen lama -- /candles?symbol=BTCUSDT&tf=h1 adalah
 *   cara baru yang direkomendasikan untuk integrasi baru.
 *
 * v4.7: Tambah OKX sebagai fallback terakhir di /price, /hourly, /daily,
 *   dan /funding (Binance -> Bybit -> Crypto.com -> OKX untuk kline/funding;
 *   Binance -> Crypto.com -> OKX untuk price). Shape response OKX
 *   (market/ticker, market/candles, public/funding-rate, public/mark-price)
 *   cocok 1:1 dengan field yang sudah dipakai exchange lain, jadi aman
 *   dipetakan langsung tanpa field kosong/palsu.
 *
 *   /market/options SENGAJA TIDAK ditambah fallback OKX. Endpoint options
 *   OKX (`public/opt-summary`) cuma balikin implied volatility & Greeks
 *   per instrumen -- tidak ada open_interest, volume, atau mark price
 *   dalam USD seperti Deribit. Memetakannya ke shape yang sama berarti
 *   ngisi oi/vol/mark dengan 0 di semua baris, yang lebih menyesatkan
 *   buat findAtmIv/classifyRegime di frontend dibanding tetap 503 dan
 *   jatuh ke market:options_stale seperti sekarang.
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
    console.warn('[market/price] crypto.com failed, trying okx:', (e as Error).message);
  }

  // Fallback 2: OKX v5 public ticker
  try {
    const r = await fetch(
      'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`OKX HTTP ${r.status}`);
    const j = await r.json() as { data?: Array<Record<string, string>> };
    const t = j?.data?.[0];
    if (!t || !t.last) throw new Error('No ticker data');
    const last = parseFloat(t.last);
    const open24h = parseFloat(t.open24h);
    const data = {
      price: last,
      high: parseFloat(t.high24h),
      low: parseFloat(t.low24h),
      change: open24h ? (last - open24h) / open24h : 0,
      vol: parseFloat(t.vol24h),
      volUsd: parseFloat(t.volCcy24h),
      ts: Date.now(),
      source: 'okx',
    };
    await kvPut(c.env.BTC_CACHE, 'market:price', data, 60);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(data);
  } catch (e) {
    console.error('[market/price] all sources failed:', (e as Error).message);
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
    console.warn('[market/hourly] crypto.com failed, trying okx:', (e as Error).message);
  }

  // Fallback 3: OKX v5 public candles
  try {
    const r = await fetch(
      'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=48',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`OKX HTTP ${r.status}`);
    const j = await r.json() as { data?: Array<Array<string>> };
    const rows = j?.data;
    if (!rows?.length) throw new Error('No candle data');
    // OKX returns newest-first, each row [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm].
    const data = rows
      .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
      .reverse();
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
    console.warn('[market/daily] crypto.com failed, trying okx:', (e as Error).message);
  }

  // Fallback 3: OKX v5 public candles
  try {
    const r = await fetch(
      'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1D&limit=60',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`OKX HTTP ${r.status}`);
    const j = await r.json() as { data?: Array<Array<string>> };
    const rows = j?.data;
    if (!rows?.length) throw new Error('No candle data');
    // OKX returns newest-first, each row [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm].
    const data = rows
      .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
      .reverse();
    await kvPut(c.env.BTC_CACHE, 'market:daily', data, 3600);
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(data);
  } catch (e) {
    console.error('[market/daily] all sources failed:', (e as Error).message);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'daily unavailable' }, 503);
  }
});

// ---- GET /api/market/candles?symbol=&tf= ----
// Endpoint generik multi timeframe & multi simbol. Lihat catatan v4.8 di
// header file ini soal kenapa XAUUSD adalah proxy PAXGUSDT, bukan forex asli.

type Tf = 'm5' | 'm15' | 'h1' | 'd1';
type SymbolId = 'BTCUSDT' | 'BTCUSDT.P' | 'XAUUSD';
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

const BINANCE_INTERVAL: Record<Tf, string> = { m5: '5m', m15: '15m', h1: '1h', d1: '1d' };
const BYBIT_INTERVAL: Record<Tf, string> = { m5: '5', m15: '15', h1: '60', d1: 'D' };
const OKX_BAR: Record<Tf, string> = { m5: '5m', m15: '15m', h1: '1H', d1: '1D' };

// Berapa candle yang diminta per timeframe -- cukup untuk ~1-2 hari data
// intraday, dan 60 hari untuk d1 (sama seperti /daily yang sudah ada).
const TF_LIMIT: Record<Tf, number> = { m5: 288, m15: 96, h1: 48, d1: 60 };

// Cache-Control / KV TTL per timeframe -- makin pendek timeframe-nya,
// makin sering perlu di-refresh.
const TF_CACHE_TTL: Record<Tf, number> = { m5: 60, m15: 180, h1: 300, d1: 3600 };

interface SymbolSpec {
  binanceSpot?: string;
  binanceFutures?: string;
  bybitSymbol?: string;
  bybitCategory?: 'spot' | 'linear';
  okxInstId?: string;
}

const SYMBOLS: Record<SymbolId, SymbolSpec> = {
  // Spot BTC/USDT.
  'BTCUSDT': {
    binanceSpot: 'BTCUSDT',
    bybitSymbol: 'BTCUSDT',
    bybitCategory: 'spot',
    okxInstId: 'BTC-USDT',
  },
  // Perpetual futures BTC (notasi ".P" seperti di TradingView).
  'BTCUSDT.P': {
    binanceFutures: 'BTCUSDT',
    bybitSymbol: 'BTCUSDT',
    bybitCategory: 'linear',
    okxInstId: 'BTC-USDT-SWAP',
  },
  // PROXY emas lewat PAXGUSDT (PAX Gold, 1 token = 1 troy ounce emas fisik
  // yang di-custody). Tidak ada exchange crypto yang punya data forex
  // XAUUSD asli secara gratis tanpa API key berbayar -- kalau butuh harga
  // forex resmi, perlu provider terpisah (Twelve Data / Alpha Vantage).
  'XAUUSD': {
    binanceSpot: 'PAXGUSDT',
    bybitSymbol: 'PAXGUSDT',
    bybitCategory: 'spot',
    okxInstId: 'PAXG-USDT',
  },
};

async function fetchBinanceCandles(
  symbol: string, interval: string, limit: number, futures: boolean,
): Promise<Candle[] | null> {
  const base = futures
    ? 'https://fapi.binance.com/fapi/v1/klines'
    : 'https://api.binance.com/api/v3/klines';
  try {
    const r = await fetch(
      `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json() as Array<Array<string | number>>;
    if (!Array.isArray(raw) || !raw.length) throw new Error('empty');
    // Binance returns oldest-first already.
    return raw.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  } catch (e) {
    console.warn(`[market/candles] binance${futures ? '-futures' : ''} ${symbol} failed:`, (e as Error).message);
    return null;
  }
}

async function fetchBybitCandles(
  symbol: string, interval: string, limit: number, category: 'spot' | 'linear',
): Promise<Candle[] | null> {
  try {
    const r = await fetch(
      `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { result?: { list?: Array<Array<string>> } };
    const rows = j?.result?.list;
    if (!rows?.length) throw new Error('empty');
    // Bybit returns newest-first; reverse to oldest-first.
    return rows
      .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
      .reverse();
  } catch (e) {
    console.warn(`[market/candles] bybit ${symbol} failed:`, (e as Error).message);
    return null;
  }
}

async function fetchOkxCandles(instId: string, bar: string, limit: number): Promise<Candle[] | null> {
  try {
    const r = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { data?: Array<Array<string>> };
    const rows = j?.data;
    if (!rows?.length) throw new Error('empty');
    // OKX returns newest-first; reverse to oldest-first.
    return rows
      .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
      .reverse();
  } catch (e) {
    console.warn(`[market/candles] okx ${instId} failed:`, (e as Error).message);
    return null;
  }
}

function buildAttempts(
  spec: SymbolSpec, tf: Tf, limit: number,
): Array<{ source: string; run: () => Promise<Candle[] | null> }> {
  const attempts: Array<{ source: string; run: () => Promise<Candle[] | null> }> = [];
  if (spec.binanceFutures) {
    attempts.push({
      source: 'binance-futures',
      run: () => fetchBinanceCandles(spec.binanceFutures!, BINANCE_INTERVAL[tf], limit, true),
    });
  }
  if (spec.binanceSpot) {
    attempts.push({
      source: 'binance',
      run: () => fetchBinanceCandles(spec.binanceSpot!, BINANCE_INTERVAL[tf], limit, false),
    });
  }
  if (spec.bybitSymbol) {
    attempts.push({
      source: 'bybit',
      run: () => fetchBybitCandles(spec.bybitSymbol!, BYBIT_INTERVAL[tf], limit, spec.bybitCategory ?? 'spot'),
    });
  }
  if (spec.okxInstId) {
    attempts.push({
      source: 'okx',
      run: () => fetchOkxCandles(spec.okxInstId!, OKX_BAR[tf], limit),
    });
  }
  return attempts;
}

marketRoutes.get('/candles', async (c) => {
  const symbolParam = (c.req.query('symbol') || 'BTCUSDT').toUpperCase();
  const tfParam = (c.req.query('tf') || 'h1').toLowerCase();

  if (!(symbolParam in SYMBOLS)) {
    c.header('Cache-Control', 'no-store');
    return c.json(
      { error: `unknown symbol '${symbolParam}', expected one of: ${Object.keys(SYMBOLS).join(', ')}` },
      400,
    );
  }
  if (!(tfParam in TF_CACHE_TTL)) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: `unknown tf '${tfParam}', expected one of: m5, m15, h1, d1` }, 400);
  }

  const symbol = symbolParam as SymbolId;
  const tf = tfParam as Tf;
  const ttl = TF_CACHE_TTL[tf];
  const limit = TF_LIMIT[tf];
  const cacheKey = `market:candles:${symbol}:${tf}`;

  const cached = await kvGet<{ symbol: SymbolId; tf: Tf; source: string; candles: Candle[] }>(
    c.env.BTC_CACHE, cacheKey,
  );
  if (cached) {
    c.header('Cache-Control', `public, max-age=${ttl}`);
    return c.json(cached);
  }

  const attempts = buildAttempts(SYMBOLS[symbol], tf, limit);
  for (const attempt of attempts) {
    const candles = await attempt.run();
    if (candles) {
      const payload = { symbol, tf, source: attempt.source, candles };
      await kvPut(c.env.BTC_CACHE, cacheKey, payload, ttl);
      c.header('Cache-Control', `public, max-age=${ttl}`);
      return c.json(payload);
    }
  }

  console.error(`[market/candles] all sources failed for ${symbol} ${tf}`);
  c.header('Cache-Control', 'no-store');
  return c.json({ error: `candles unavailable for ${symbol} ${tf}` }, 503);
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
    console.warn('[market/funding] bybit failed, trying okx:', (e as Error).message);
  }

  // Fallback 2: OKX v5 public funding-rate (+ mark-price, best-effort)
  try {
    const r = await fetch(
      'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`OKX HTTP ${r.status}`);
    const j = await r.json() as { data?: Array<{ fundingRate?: string; nextFundingTime?: string }> };
    const row = j?.data?.[0];
    if (!row?.fundingRate) throw new Error('No funding data');
    const rate = parseFloat(row.fundingRate);

    // OKX splits mark price into a separate endpoint (funding-rate itself
    // has no mark price field) -- same best-effort pattern as the Bybit
    // mark price lookup above.
    let markPrice = 0;
    try {
      const mr = await fetch(
        'https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=BTC-USDT-SWAP',
        { signal: AbortSignal.timeout(6000) },
      );
      const mj = await mr.json() as { data?: Array<{ markPx?: string }> };
      markPrice = parseFloat(mj?.data?.[0]?.markPx ?? '0');
    } catch { /* non-fatal, keep markPrice = 0 */ }

    const data = {
      rate,
      ratePct: rate * 100,
      annualizedPct: rate * 3 * 365 * 100,
      markPrice,
      nextFundingMs: row.nextFundingTime ? +row.nextFundingTime : null,
      flag:
        Math.abs(rate) > 0.0003
          ? rate > 0 ? 'long-extreme' : 'short-extreme'
          : Math.abs(rate) > 0.0001
          ? rate > 0 ? 'long-heavy' : 'short-heavy'
          : 'neutral',
      ts: Date.now(),
      source: 'okx',
    };
    await kvPut(c.env.BTC_CACHE, 'market:funding', data, 600);
    c.header('Cache-Control', 'public, max-age=600');
    return c.json(data);
  } catch (e) {
    console.error('[market/funding] all sources failed:', (e as Error).message);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'funding unavailable' }, 503);
  }
});

// ---- GET /api/market/options ----
// Deribit-only, sengaja tidak ditambah fallback OKX -- lihat catatan v4.7
// di header file ini soal ketidakcocokan shape data (oi/vol/mark).

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
