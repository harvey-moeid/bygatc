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

// -- Allow-list skema payload -------------------------------------------
//
// Sebelumnya seluruh body (`...b`) di-spread langsung ke KV tanpa skema --
// cuma upside/volAmp yang divalidasi. Field lain lolos apa adanya dan
// diserve verbatim lewat GET /latest, lalu beberapa di antaranya (sourceTs,
// proxy, freshness) dirender ke innerHTML di ui.js. Selama NOCTUA_PUSH_SECRET
// tidak bocor ini aman (pipeline model tepercaya), tapi kalau bocor ini jadi
// jalur stored-XSS langsung ke browser setiap pengunjung dashboard. Payload
// dari model/serve/predict.py::to_legacy() + forecast() sekarang divalidasi
// strict di sini: field yang tidak dikenal dibuang, field yang dikenal
// dipaksa ke tipe yang diharapkan, dan string dibatasi panjang + dibersihkan
// dari karakter kontrol. Ini pertahanan lapis-server; ui.js tetap HARUS
// meng-escape setiap field ini sebelum masuk innerHTML (lihat ui.js).

const MAX_STR_LEN = 500;

function safeStr(v: unknown, maxLen = MAX_STR_LEN): string | undefined {
  if (typeof v !== 'string') return undefined;
  // Buang karakter kontrol (termasuk null byte); potong ke panjang maksimum.
  const cleaned = v.replace(/[\u0000-\u001F\u007F]/g, '');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function safeNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function safeBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

// Untuk field kompleks (safe_levels, barrier_curves, vol_calibration): tidak
// mem-blok struktur model yang bisa berkembang, tapi memastikan hasilnya
// selalu JSON "polos" -- cuma object/array/string/number/boolean/null, tanpa
// function, tanpa __proto__, dengan batas kedalaman & ukuran supaya body raksasa
// tidak bisa membengkakkan KV.
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
  return null; // function, symbol, dll -- tidak diizinkan
}

// Field string/number/boolean dikenal, datang dari to_legacy() (BGTC) dan
// forecast() (noctua) di model/serve/predict.py, digabung oleh merge_payload.py.
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

// Field terstruktur (array/object bertingkat) -- dibersihkan lewat safeJson(),
// bukan divalidasi field-per-field, supaya skema model masih boleh berevolusi.
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

  // Validasi type + range – cegah nilai luar batas masuk KV dan ditampilkan di dashboard
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

  // Hanya field yang dikenal & sudah divalidasi tipe/panjangnya yang masuk KV --
  // tidak ada lagi `...b` mentah. Field tak dikenal dibuang diam-diam.
  const payload = {
    ...sanitizePayload(b, upside, volAmp),
    _receivedMs: Date.now(),
    _updatedMs: Date.now(),
  };

  // TTL 26 jam – model jalan sehari sekali, kasih buffer
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
