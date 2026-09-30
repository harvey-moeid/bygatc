import { Hono } from 'hono';
import type { Env } from '../index';
import { checkFuturesVolAlert } from '../lib/futuresSignal';

type NoctuaEnv = Env & { NOCTUA_PUSH_SECRET: string };

export const noctuaRoutes = new Hono<{ Bindings: NoctuaEnv }>();

const MAX_STR_LEN = 500;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function safeStr(v: unknown, maxLen = MAX_STR_LEN): string | undefined {
  if (typeof v !== 'string') return undefined;
  const cleaned = v.replace(/[\u0000-\u001F\u007F]/g, '');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}
function safeNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function safeBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function safeJson(v: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return safeStr(v, 200) ?? '';
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => safeJson(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (++count > 100) break;
      out[k] = safeJson(val, depth + 1);
    }
    return out;
  }
  return null;
}

const STRING_FIELDS = [
  'sourceTs', 'tz', 'proxy', 'freshness', 'model', 'warning',
  'source', 'anchor_utc', 'settle_utc', '_source',
] as const;
const NUMBER_FIELDS = [
  'p_up_raw', 'sourceMs', 'ageHrs', 'fetchedAt', '_updatedMs',
  'H_hours', 'spot', 'sigma_window_pct', 'sigma_annualized_pct',
  'trailing_rv_pct', 'p_up', 'p_vol_amplify', 'history_hours',
] as const;
const BOOL_FIELDS = ['upside_is_informative'] as const;
const JSON_FIELDS = ['safe_levels', 'barrier_curves', 'vol_calibration'] as const;

function sanitizePayload(b: Record<string, unknown>, upside: number, volAmp: number) {
  const out: Record<string, unknown> = { upside, volAmp };
  for (const k of STRING_FIELDS) {
    const s = safeStr(b[k]);
    if (s !== undefined) out[k] = s;
  }
  for (const k of NUMBER_FIELDS) {
    const n = safeNum(b[k]);
    if (n !== undefined) out[k] = n;
  }
  for (const k of BOOL_FIELDS) {
    const bo = safeBool(b[k]);
    if (bo !== undefined) out[k] = bo;
  }
  for (const k of JSON_FIELDS) {
    if (b[k] !== undefined) out[k] = safeJson(b[k]);
  }
  return out;
}

function authorized(request: Request, secret: string): boolean {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/, '');
  return Boolean(token && token === secret);
}

noctuaRoutes.post('/push', async (c) => {
  if (!authorized(c.req.raw, c.env.NOCTUA_PUSH_SECRET)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const b = body as Record<string, unknown>;
  const upside = b['upside'];
  const volAmp = b['volAmp'];

  if (
    typeof upside !== 'number' || typeof volAmp !== 'number' ||
    upside < 0 || upside > 100 || volAmp < 0 || volAmp > 100
  ) {
    return c.json(
      { error: 'missing or out-of-range upside/volAmp (expected numbers in 0-100)' },
      400,
    );
  }

  const payload = {
    ...sanitizePayload(b, upside, volAmp),
    _receivedMs: Date.now(),
    _updatedMs: Date.now(),
  };

  await c.env.BTC_CACHE.put('noctua:latest', JSON.stringify(payload), {
    expirationTtl: 93600,
  });

  await checkFuturesVolAlert(c.env, payload);
  return c.json({ ok: true });
});

noctuaRoutes.post('/data/upload', async (c) => {
  if (!authorized(c.req.raw, c.env.NOCTUA_PUSH_SECRET)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const format = c.req.query('format') === 'csv' ? 'csv' : 'parquet';
  const contentLength = Number(c.req.header('Content-Length') || '0');
  if (contentLength > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'file too large' }, 413);
  }

  const body = await c.req.raw.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: 'empty upload' }, 400);
  if (body.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large' }, 413);

  const key = format === 'csv'
    ? 'exports/noctua_history.csv'
    : 'exports/noctua_history.parquet';

  await c.env.NOCTUA_DATA.put(key, body, {
    httpMetadata: {
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/octet-stream',
      contentDisposition: `attachment; filename="noctua_history.${format}"`,
      cacheControl: 'public, max-age=300',
    },
  });

  return c.json({ ok: true, key, size_bytes: body.byteLength });
});

noctuaRoutes.get('/latest', async (c) => {
  const raw = await c.env.BTC_CACHE.get('noctua:latest');
  if (!raw) return c.json({ error: 'no prediction available yet' }, 404);
  return c.json(JSON.parse(raw));
});

noctuaRoutes.get('/data', async (c) => {
  const parquet = await c.env.NOCTUA_DATA.head('exports/noctua_history.parquet');
  const csv = await c.env.NOCTUA_DATA.head('exports/noctua_history.csv');
  if (!parquet && !csv) return c.json({ error: 'history export not available yet' }, 404);

  return c.json({
    ok: true,
    parquet: parquet ? {
      key: 'exports/noctua_history.parquet',
      size_bytes: parquet.size,
      uploaded: parquet.uploaded.toISOString(),
      etag: parquet.etag,
    } : null,
    csv: csv ? {
      key: 'exports/noctua_history.csv',
      size_bytes: csv.size,
      uploaded: csv.uploaded.toISOString(),
      etag: csv.etag,
    } : null,
    download_parquet: '/api/noctua/download?format=parquet',
    download_csv: '/api/noctua/download?format=csv',
  });
});

noctuaRoutes.get('/download', async (c) => {
  const format = c.req.query('format') === 'csv' ? 'csv' : 'parquet';
  const key = format === 'csv'
    ? 'exports/noctua_history.csv'
    : 'exports/noctua_history.parquet';

  const object = await c.env.NOCTUA_DATA.get(key);
  if (!object?.body) return c.json({ error: `${format} history export not available yet` }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Disposition', `attachment; filename="noctua_history.${format}"`);
  headers.set('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=300');
  return new Response(object.body, { headers });
});

noctuaRoutes.get('/download/noctua-history', async (c) => {
  const format = c.req.query('format') === 'csv' ? 'csv' : 'parquet';
  const object = await c.env.NOCTUA_DATA.get(
    format === 'csv' ? 'exports/noctua_history.csv' : 'exports/noctua_history.parquet',
  );
  if (!object?.body) return c.json({ error: 'history export not available yet' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Disposition', `attachment; filename="noctua_history.${format}"`);
  headers.set('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=300');
  return new Response(object.body, { headers });
});