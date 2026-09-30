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

// Public data API: semua route GET di bawah ini cuma menyajikan data yang
// sudah publik (harga, funding, prediksi NOCTUA, news, dsb), jadi CORS
// dibuka untuk semua origin supaya bisa dipanggil langsung dari web lain
// mana pun tanpa perlu didaftarkan satu-satu ke whitelist.
//
// Endpoint tulis (POST /api/noctua/push, /api/noctua/data/upload, PUT
// /api/alerts/config) tetap diproteksi lewat secret bearer token terlepas
// dari kebijakan CORS ini -- CORS cuma aturan browser, bukan pengganti
// auth, jadi membuka origin tidak membuka endpoint tersebut.
app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
);

app.route('/api/market', marketRoutes);
app.route('/api/enrichment', enrichmentRoutes);
app.route('/api/noctua', noctuaRoutes);
app.route('/api/alerts', alertsRoutes);

// Alias versi stabil (v1) untuk konsumen eksternal. Kontrak response di
// route-route yang di-mount di sini dijaga tidak berubah secara breaking.
// Kalau suatu saat perlu ubah shape data, tambahkan /api/v2/* baru di
// samping ini, jangan ubah yang lama.
app.route('/api/v1/market', marketRoutes);
app.route('/api/v1/enrichment', enrichmentRoutes);
app.route('/api/v1/noctua', noctuaRoutes);

app.get('/api/health', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: true,
    ts: Date.now(),
    env: c.env.BTC_CACHE ? 'kv-ok' : 'no-kv',
    noctuaData: c.env.NOCTUA_DATA ? 'r2-ok' : 'no-r2',
  });
});

// Index ringkas supaya konsumen eksternal (web lain) bisa discover endpoint
// yang tersedia tanpa perlu baca source code Worker. Lihat juga
// docs/api.md di root repo untuk detail shape response & cache TTL.
app.get('/api', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    ok: true,
    version: 'v1',
    docs: 'docs/api.md',
    endpoints: {
      health: '/api/health',
      market: {
        price: '/api/v1/market/price',
        hourly: '/api/v1/market/hourly',
        daily: '/api/v1/market/daily',
        funding: '/api/v1/market/funding',
        options: '/api/v1/market/options',
      },
      enrichment: {
        news: '/api/v1/enrichment/news',
        fearGreed: '/api/v1/enrichment/fg',
      },
      noctua: {
        latest: '/api/v1/noctua/latest',
        data: '/api/v1/noctua/data',
        download: '/api/v1/noctua/download?format=parquet|csv',
      },
    },
  });
});

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
