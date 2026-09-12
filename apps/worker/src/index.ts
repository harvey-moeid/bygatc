import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { marketRoutes } from './routes/market';
import { enrichmentRoutes } from './routes/enrichment';
import { noctuaRoutes } from './routes/noctua';
import { alertsRoutes } from './routes/alerts';
import { runEnrichmentCron } from './cron/enrichment';
import { runPriceAlertCron } from './cron/priceAlert';

export type Env = {
  BTC_CACHE: KVNamespace;
  EXA_API_KEY?: string; // optional secret
  DISCORD_WEBHOOK_URL?: string; // secret -- webhook Discord untuk price alert
  ALERTS_SECRET?: string; // secret -- proteksi PUT/GET /api/alerts/config
  ALERT_PRICE_UPPER?: string; // optional var -- default threshold atas kalau KV kosong
  ALERT_PRICE_LOWER?: string; // optional var -- default threshold bawah kalau KV kosong
};

const app = new Hono<{ Bindings: Env }>();

// CORS â izinkan hostname yang benar-benar diketahui, bukan sekadar
// "mengandung" string tertentu.
//
// Sebelumnya: origin.includes('btc-dashboard') / .includes('pages.dev') /
// .includes('localhost') dsb. -- ini BUKAN pengecekan hostname, jadi origin
// apa pun yang cuma MEMUAT string itu di mana saja lolos, misalnya
// "https://btc-dashboard.evil.com" atau situs lain mana pun di domain publik
// bersama *.pages.dev. Sejak wrangler.toml pakai [assets] (frontend & Worker
// di-serve dari origin yang sama), permintaan dari dashboard produksi itu
// sendiri sebenarnya SAME-ORIGIN dan tidak lewat jalur CORS ini sama sekali
// -- origin whitelist di bawah cuma untuk: (a) dev lokal, dan (b) Cloudflare
// Pages preview/branch deployments di *.pages.dev kalau suatu saat dipakai
// lagi.
function isAllowedOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  // Cocokkan akhiran hostname yang sebenarnya, bukan substring di posisi
  // manapun -- "evil-pages.dev.attacker.com".includes('pages.dev') === true,
  // tapi hostname itu TIDAK berakhiran ".pages.dev".
  if (hostname === 'pages.dev' || hostname.endsWith('.pages.dev')) return true;
  return false;
}

app.use(
  '/api/*',
  cors({
    origin: (origin) => {
      if (!origin) return '*';
      return isAllowedOrigin(origin) ? origin : null;
    },
    allowMethods: ['GET', 'OPTIONS'],
    maxAge: 300,
  }),
);

// ---- Routes ----
app.route('/api/market', marketRoutes);
app.route('/api/enrichment', enrichmentRoutes);
app.route('/api/noctua', noctuaRoutes);
app.route('/api/alerts', alertsRoutes);

// Health check
app.get('/api/health', (c) =>
  c.json({ ok: true, ts: Date.now(), env: c.env.BTC_CACHE ? 'kv-ok' : 'no-kv' }),
);

// ---- Cron handler ----
// Dipanggil Cloudflare sesuai `crons` di wrangler.toml:
//   '0 * * * *'   -> enrichment (news + fear & greed), tiap jam
//   '*/5 * * * *' -> price alert (breakout threshold Discord), tiap 5 menit
export default {
  fetch: app.fetch,

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    console.log(`[cron] scheduled fired: ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(runEnrichmentCron(env));
    } else if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(runPriceAlertCron(env));
    }
  },
};
