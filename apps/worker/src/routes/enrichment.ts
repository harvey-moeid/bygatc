/**
 * routes/enrichment.ts
 * -------------------------------------------------------------------
 * Serve data yang sudah di-cache oleh cron:
 *   GET /api/enrichment/news  -> enrichment:news dari KV
 *   GET /api/enrichment/fg    -> enrichment:fg dari KV
 *
 * Jika KV kosong (sebelum cron pertama), trigger enrichment via
 * waitUntil (fire-and-forget) dan langsung return 503 agar Worker
 * tidak blocking sampai timeout. Browser bisa retry setelah ~30s.
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import { runEnrichmentCron } from '../cron/enrichment';

export const enrichmentRoutes = new Hono<{ Bindings: Env }>();

enrichmentRoutes.get('/news', async (c) => {
  const raw = await c.env.BTC_CACHE.get('enrichment:news');
  if (raw) return c.json(JSON.parse(raw));

  // KV miss sebelum cron pertama jalan.
  // Gunakan waitUntil agar fetch jalan di background tanpa block request.
  // Jangan await langsung  -  bisa timeout (CF Worker limit 30s CPU).
  console.warn('[enrichment/news] KV miss  -  triggering background enrichment');
  c.executionCtx.waitUntil(runEnrichmentCron(c.env));
  return c.json({ error: 'data warming up, retry in 30s' }, 503);
});

enrichmentRoutes.get('/fg', async (c) => {
  const raw = await c.env.BTC_CACHE.get('enrichment:fg');
  if (raw) return c.json(JSON.parse(raw));

  console.warn('[enrichment/fg] KV miss  -  triggering background enrichment');
  c.executionCtx.waitUntil(runEnrichmentCron(c.env));
  return c.json({ error: 'data warming up, retry in 30s' }, 503);
});