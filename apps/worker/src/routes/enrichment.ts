/**
 * routes/enrichment.ts
 * ─────────────────────────────────────────────────────────────────────
 * Serve data yang sudah di-cache oleh cron:
 *   GET /api/enrichment/news  → enrichment:news dari KV
 *   GET /api/enrichment/fg    → enrichment:fg dari KV
 *
 * Jika KV kosong (belum ada cron pertama), jalankan fetch on-demand
 * dan simpan ke KV sebagai fallback.
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import { runEnrichmentCron } from '../cron/enrichment';

export const enrichmentRoutes = new Hono<{ Bindings: Env }>();

enrichmentRoutes.get('/news', async (c) => {
  const raw = await c.env.BTC_CACHE.get('enrichment:news');
  if (raw) return c.json(JSON.parse(raw));

  // Fallback on-demand — pertama kali sebelum cron jalan
  console.warn('[enrichment/news] KV miss — running on-demand');
  await runEnrichmentCron(c.env);

  const fresh = await c.env.BTC_CACHE.get('enrichment:news');
  if (fresh) return c.json(JSON.parse(fresh));
  return c.json({ error: 'news unavailable' }, 503);
});

enrichmentRoutes.get('/fg', async (c) => {
  const raw = await c.env.BTC_CACHE.get('enrichment:fg');
  if (raw) return c.json(JSON.parse(raw));

  console.warn('[enrichment/fg] KV miss — running on-demand');
  await runEnrichmentCron(c.env);

  const fresh = await c.env.BTC_CACHE.get('enrichment:fg');
  if (fresh) return c.json(JSON.parse(fresh));
  return c.json({ error: 'fg unavailable' }, 503);
});
