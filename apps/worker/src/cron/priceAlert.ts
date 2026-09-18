/**
 * cron/priceAlert.ts
 * -------------------------------------------------------------------
 * Dijalankan Cloudflare Cron Trigger setiap 5 menit (lihat wrangler.toml,
 * trigger kedua di [triggers].crons).
 *
 * Cek harga spot BTC terhadap threshold breakout yang tersimpan di KV,
 * kirim notif Discord kalau harga menembus. Pakai hysteresis (buffer 0.3%)
 * supaya harga yang mepet-mepet di garis threshold tidak memicu notif
 * berulang tiap 5 menit selama masih di luar band -- notif cuma sekali per
 * crossing, reset otomatis begitu harga balik ke dalam band.
 *
 * Tiap notif breakout sekarang deep-link ke dashboard (klik judul embed di
 * Discord langsung buka halaman utama) -- lihat lib/discord.ts::dashboardUrl().
 *
 * Teks notif memakai istilah trading standar (Breakout / Breakdown, Current
 * Price, Trigger Level) supaya langsung familiar buat trader.
 *
 * KV keys:
 *   alert:price_config -- { upper?: number, lower?: number }
 *     Diset lewat PUT /api/alerts/config (lihat routes/alerts.ts).
 *     Kalau kosong dan env ALERT_PRICE_UPPER/ALERT_PRICE_LOWER ada, dipakai
 *     sebagai default (tidak wajib -- keduanya optional, boleh isi salah satu).
 *   alert:price_state -- { above: boolean, below: boolean }
 *     Status breakout terakhir, dipakai buat hysteresis di atas.
 *
 * Kalau upper & lower dua-duanya tidak diset (KV kosong + env kosong),
 * cron ini no-op (tidak fetch harga, tidak kirim apa-apa).
 */

import type { Env } from '../index';
import { sendDiscordAlert, dashboardUrl } from '../lib/discord';

type PriceConfig = { upper?: number; lower?: number };
type PriceState = { above: boolean; below: boolean };

const HYSTERESIS_PCT = 0.003; // 0.3% buffer sebelum status breakout di-reset

async function fetchSpotPrice(env: Env): Promise<number | null> {
  // Pakai cache dari GET /api/market/price kalau masih segar (< 6 menit),
  // supaya tidak dobel-fetch ke exchange tiap 5 menit di luar cache 60s-nya
  // route itu sendiri.
  const cachedRaw = await env.BTC_CACHE.get('market:price');
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as { price?: number; ts?: number };
      if (
        typeof cached.price === 'number' &&
        typeof cached.ts === 'number' &&
        Date.now() - cached.ts < 360_000
      ) {
        return cached.price;
      }
    } catch {
      // korup / format tak terduga -- lanjut fetch fresh di bawah
    }
  }

  // Primary: Binance
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
    const j = (await r.json()) as { price?: string };
    const p = parseFloat(j.price ?? '');
    if (Number.isFinite(p)) return p;
    throw new Error('No price in response');
  } catch (e) {
    console.warn('[cron:priceAlert] binance failed, trying crypto.com:', (e as Error).message);
  }

  // Fallback: Crypto.com (pola sama dengan routes/market.ts)
  try {
    const r = await fetch(
      'https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=BTCUSD-PERP',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) throw new Error(`CryptoCom HTTP ${r.status}`);
    const j = (await r.json()) as { result?: { data?: Array<Record<string, string>> } };
    const p = parseFloat(j?.result?.data?.[0]?.['a'] ?? '');
    if (Number.isFinite(p)) return p;
    throw new Error('No ticker data');
  } catch (e) {
    console.error('[cron:priceAlert] both price sources failed:', (e as Error).message);
    return null;
  }
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export async function runPriceAlertCron(env: Env): Promise<void> {
  const configRaw = await env.BTC_CACHE.get('alert:price_config');
  let config: PriceConfig = {};
  if (configRaw) {
    try {
      config = JSON.parse(configRaw) as PriceConfig;
    } catch {
      console.warn('[cron:priceAlert] alert:price_config korup, diabaikan');
    }
  }

  const upper = config.upper ?? (env.ALERT_PRICE_UPPER ? parseFloat(env.ALERT_PRICE_UPPER) : undefined);
  const lower = config.lower ?? (env.ALERT_PRICE_LOWER ? parseFloat(env.ALERT_PRICE_LOWER) : undefined);

  if (upper === undefined && lower === undefined) {
    // Belum ada threshold yang diset sama sekali -- tidak ada yang dicek.
    return;
  }

  const price = await fetchSpotPrice(env);
  if (price === null) return;

  const stateRaw = await env.BTC_CACHE.get('alert:price_state');
  let state: PriceState = { above: false, below: false };
  if (stateRaw) {
    try {
      state = JSON.parse(stateRaw) as PriceState;
    } catch {
      console.warn('[cron:priceAlert] alert:price_state korup, direset');
    }
  }

  let changed = false;

  if (upper !== undefined) {
    if (price >= upper && !state.above) {
      const ok = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
        embeds: [
          {
            title: 'BTC Breakout: Above Upper Level',
            url: dashboardUrl(env),
            description: `BTC broke above your upper alert level of **$${fmtUsd(upper)}**. Upside breakout.`,
            color: 0x22c55e, // hijau
            fields: [
              { name: 'Current Price', value: `$${fmtUsd(price)}`, inline: true },
              { name: 'Trigger Level', value: `$${fmtUsd(upper)}`, inline: true },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });
      console.log(`[cron:priceAlert] upper breakout @ $${fmtUsd(price)} (threshold $${fmtUsd(upper)}), notif ${ok ? 'terkirim' : 'gagal'}`);
      state.above = true;
      changed = true;
    } else if (price < upper * (1 - HYSTERESIS_PCT) && state.above) {
      // Harga sudah balik masuk band -- reset, supaya crossing berikutnya bisa notif lagi.
      state.above = false;
      changed = true;
    }
  }

  if (lower !== undefined) {
    if (price <= lower && !state.below) {
      const ok = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
        embeds: [
          {
            title: 'BTC Breakdown: Below Lower Level',
            url: dashboardUrl(env),
            description: `BTC broke below your lower alert level of **$${fmtUsd(lower)}**. Downside breakdown.`,
            color: 0xef4444, // merah
            fields: [
              { name: 'Current Price', value: `$${fmtUsd(price)}`, inline: true },
              { name: 'Trigger Level', value: `$${fmtUsd(lower)}`, inline: true },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });
      console.log(`[cron:priceAlert] lower breakdown @ $${fmtUsd(price)} (threshold $${fmtUsd(lower)}), notif ${ok ? 'terkirim' : 'gagal'}`);
      state.below = true;
      changed = true;
    } else if (price > lower * (1 + HYSTERESIS_PCT) && state.below) {
      state.below = false;
      changed = true;
    }
  }

  if (changed) {
    await env.BTC_CACHE.put('alert:price_state', JSON.stringify(state), { expirationTtl: 604800 });
  }
}
