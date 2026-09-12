import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { marketRoutes } from './routes/market';
import { enrichmentRoutes } from './routes/enrichment';
import { noctuaRoutes } from './routes/noctua';
import { runEnrichmentCron } from './cron/enrichment';

export type Env = {
  BTC_CACHE: KVNamespace;
  EXA_API_KEY?: string; // optional secret
};

const app = new Hono<{ Bindings: Env }>();

// CORS – izinkan hostname yang benar-benar diketahui, bukan sekadar
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

// Health check
app.get('/api/health', (c) =>
  c.json({ ok: true, ts: Date.now(), env: c.env.BTC_CACHE ? 'kv-ok' : 'no-kv' }),
);

// ---- Cron handler ----
// Dipanggil Cloudflare setiap jam sesuai `crons` di wrangler.toml
export default {
  fetch: app.fetch,

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    console.log(`[cron] scheduled fired: ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);
    ctx.waitUntil(runEnrichmentCron(env));
  },
};
