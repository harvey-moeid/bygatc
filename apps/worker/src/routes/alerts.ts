/**
 * routes/alerts.ts
 * -------------------------------------------------------------------
 * Endpoint admin untuk atur threshold price alert (dipakai cron/priceAlert.ts
 * lewat KV key `alert:price_config`). Diproteksi dengan pola yang sama
 * dengan NOCTUA_PUSH_SECRET di routes/noctua.ts -- header
 * `Authorization: Bearer <ALERTS_SECRET>`.
 *
 *   GET  /api/alerts/config
 *     -> { upper?: number, lower?: number }
 *
 *   PUT  /api/alerts/config
 *     body: { "upper"?: number, "lower"?: number }
 *     Kirim field yang mau diisi saja; field yang tidak dikirim / bukan
 *     angka positif dianggap "nonaktifkan sisi itu". Contoh:
 *       curl -X PUT https://.../api/alerts/config \
 *         -H "Authorization: Bearer $ALERTS_SECRET" \
 *         -H "Content-Type: application/json" \
 *         -d '{"upper": 120000, "lower": 100000}'
 *
 * Setiap kali threshold diganti, status breakout (alert:price_state) di-reset
 * supaya threshold baru dievaluasi dari nol, bukan mewarisi status "above"/
 * "below" dari threshold lama.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index';

type AlertsEnv = Env & { ALERTS_SECRET?: string };

export const alertsRoutes = new Hono<{ Bindings: AlertsEnv }>();

function checkAuth(c: Context<{ Bindings: AlertsEnv }>): boolean {
  const secret = c.env.ALERTS_SECRET;
  if (!secret) return false; // belum dikonfigurasi -- tolak semua akses
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/, '');
  return !!token && token === secret;
}

alertsRoutes.get('/config', async (c) => {
  if (!checkAuth(c)) return c.json({ error: 'unauthorized' }, 401);
  const raw = await c.env.BTC_CACHE.get('alert:price_config');
  let config: Record<string, unknown> = {};
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch {
      return c.json({ error: 'stored config corrupted' }, 500);
    }
  }
  return c.json(config);
});

alertsRoutes.put('/config', async (c) => {
  if (!checkAuth(c)) return c.json({ error: 'unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const b = body as Record<string, unknown>;

  const config: { upper?: number; lower?: number } = {};
  if (typeof b.upper === 'number' && Number.isFinite(b.upper) && b.upper > 0) {
    config.upper = b.upper;
  }
  if (typeof b.lower === 'number' && Number.isFinite(b.lower) && b.lower > 0) {
    config.lower = b.lower;
  }
  if (config.upper !== undefined && config.lower !== undefined && config.lower >= config.upper) {
    return c.json({ error: 'lower must be less than upper' }, 400);
  }
  if (config.upper === undefined && config.lower === undefined) {
    return c.json({ error: 'must provide at least one of upper/lower as a positive number' }, 400);
  }

  await c.env.BTC_CACHE.put('alert:price_config', JSON.stringify(config));
  await c.env.BTC_CACHE.delete('alert:price_state');

  return c.json({ ok: true, config });
});
