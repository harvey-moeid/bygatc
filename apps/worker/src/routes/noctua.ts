/**
 * routes/noctua.ts
 * -------------------------------------------------------------------
 * Bridge antara GH Actions (Python NOCTUA model) dan dashboard browser.
 *
 * GH Actions menjalankan model/serve/predict.py, lalu POST hasilnya ke:
 *   POST /api/noctua/push  (dengan header Authorization: Bearer <secret>)
 * Worker menyimpan ke KV.
 *
 * Dashboard browser fetch dari:
 *   GET  /api/noctua/latest
 *
 * Secret dikonfigurasi sebagai wrangler secret: NOCTUA_PUSH_SECRET
 * Di GH Actions: set repo secret NOCTUA_PUSH_SECRET dengan value yang sama.
 */

import { Hono } from 'hono';
import type { Env } from '../index';

type NoctuaEnv = Env & { NOCTUA_PUSH_SECRET: string };

export const noctuaRoutes = new Hono<{ Bindings: NoctuaEnv }>();

// -- POST /api/noctua/push -- dipanggil GH Actions ----------------------

noctuaRoutes.post('/push', async (c) => {
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/, '');

  if (!token || token !== c.env.NOCTUA_PUSH_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const b = body as Record<string, unknown>;

  // Validasi type + range — cegah nilai luar batas masuk KV dan ditampilkan di dashboard
  const upside = b['upside'];
  const volAmp = b['volAmp'];
  if (
    typeof upside !== 'number' || typeof volAmp !== 'number' ||
    upside < 0 || upside > 100 ||
    volAmp < 0 || volAmp > 100
  ) {
    return c.json(
      { error: 'missing or out-of-range upside/volAmp (expected numbers in 0-100)' },
      400,
    );
  }

  const payload = {
    ...b,
    _receivedMs: Date.now(),
    _updatedMs: Date.now(),
  };

  // TTL 26 jam — model jalan sehari sekali, kasih buffer
  await c.env.BTC_CACHE.put('noctua:latest', JSON.stringify(payload), {
    expirationTtl: 93600,
  });

  console.log(`[noctua/push] stored: upside=${upside} volAmp=${volAmp}`);
  return c.json({ ok: true });
});

// -- GET /api/noctua/latest -- dipanggil browser ------------------------

noctuaRoutes.get('/latest', async (c) => {
  const raw = await c.env.BTC_CACHE.get('noctua:latest');
  if (!raw) return c.json({ error: 'no prediction available yet' }, 404);
  return c.json(JSON.parse(raw));
});
