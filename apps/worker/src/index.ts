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

// CORS — izinkan Pages domain dan localhost dev
app.use(
  '/api/*',
  cors({
    origin: (origin) => {
      if (!origin) return '*';
      if (
        origin.includes('btc-dashboard') ||
        origin.includes('pages.dev') ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1')
      ) {
        return origin;
      }
      return null;
    },
    allowMethods: ['GET', 'OPTIONS'],
    maxAge: 300,
  }),
);

// ── Routes ──────────────────────────────────────────────────────────────
app.route('/api/market', marketRoutes);
app.route('/api/enrichment', enrichmentRoutes);
app.route('/api/noctua', noctuaRoutes);

// Health check
app.get('/api/health', (c) =>
  c.json({ ok: true, ts: Date.now(), env: c.env.BTC_CACHE ? 'kv-ok' : 'no-kv' }),
);

// ── Cron handler ─────────────────────────────────────────────────────────
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
