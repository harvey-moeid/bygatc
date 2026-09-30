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
  NOCTUA_DATA: R2Bucket;
  EXA_API_KEY?: string;
  DISCORD_WEBHOOK_URL?: string;
  ALERTS_SECRET?: string;
  ALERT_PRICE_UPPER?: string;
  ALERT_PRICE_LOWER?: string;
  DASHBOARD_URL?: string;
};

const app = new Hono<{ Bindings: Env }>();

function isAllowedOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
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

app.route('/api/market', marketRoutes);
app.route('/api/enrichment', enrichmentRoutes);
app.route('/api/noctua', noctuaRoutes);
app.route('/api/alerts', alertsRoutes);

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    ts: Date.now(),
    env: c.env.BTC_CACHE ? 'kv-ok' : 'no-kv',
    noctuaData: c.env.NOCTUA_DATA ? 'r2-ok' : 'no-r2',
  }),
);

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
