/**
 * cron/enrichment.ts
 * -------------------------------------------------------------------
 * Dijalankan oleh Cloudflare Cron Trigger setiap jam.
 * Port dari scripts/fetch-enrichment.js (GH Actions) ke Worker.
 * Bedanya: tidak ada fs.writeFileSync, output disimpan ke KV.
 *
 * KV keys yang ditulis:
 *   enrichment:news   — merged CryptoPanic + GDELT + Exa (optional)
 *   enrichment:fg     — Fear & Greed index
 *
 * TTL KV = 2 jam (7200 s) — cukup untuk 1-jam cron cycle + buffer.
 */

import type { Env } from '../index';

// ---- sentiment scorer (sama dengan fetch-enrichment.js) ----
function scoreSentiment(text: string): 'pos' | 'neg' | 'neu' {
  const t = (text || '').toLowerCase();
  const bull = [
    'bullish', 'rally', 'surge', 'breakout', 'recover', 'buy', 'inflow',
    'institutional', 'adoption', 'higher', 'gain', 'green', 'pump', 'above',
    'rebound', 'ath', 'all-time high', 'soar', 'jump', 'spike', 'optimistic',
    'accumulat', 'bull case', 'upgrade',
  ];
  const bear = [
    'bearish', 'crash', 'drop', 'fall', 'bear', 'sell', 'liquidat', 'fear',
    'panic', 'below', 'loss', 'red', 'dump', 'warning', 'risk', 'decline',
    'bottom', 'correction', 'capitulat', 'plunge', 'tumble', 'slide',
    'downgrade', 'weakness',
  ];
  let s = 0;
  bull.forEach((w) => { if (t.includes(w)) s++; });
  bear.forEach((w) => { if (t.includes(w)) s--; });
  return s > 0 ? 'pos' : s < 0 ? 'neg' : 'neu';
}

type NewsItem = {
  headline: string;
  url: string;
  src: string;
  sent: 'pos' | 'neg' | 'neu';
  date?: string;
};

function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    let host = '';
    try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch { /* skip */ }
    const titleKey = (it.headline || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const key = `${host}|${titleKey}`;
    const titleOnlyKey = `t|${titleKey}`;
    if (seen.has(key) || (titleKey.length > 20 && seen.has(titleOnlyKey))) continue;
    seen.add(key);
    seen.add(titleOnlyKey);
    out.push(it);
  }
  return out;
}

async function get(url: string, ms = 15000, headers: Record<string, string> = {}): Promise<Response> {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { 'User-Agent': 'btc-dashboard-cf/1.0', ...headers },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r;
}

// ---- sumber berita ----

async function fetchCryptoPanic(): Promise<NewsItem[]> {
  const xml = await (await get('https://cryptopanic.com/news/rss/?currencies=BTC')).text();
  const itemRegex = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/g;
  const items: NewsItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) && items.length < 15) {
    const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = m[2].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    let src = 'CryptoPanic';
    try { src = new URL(link).hostname.replace(/^www\./, ''); } catch { /* default */ }
    items.push({ headline: title, url: link, src, sent: scoreSentiment(title) });
  }
  return items;
}

async function fetchGdelt(): Promise<NewsItem[]> {
  const url =
    'https://api.gdeltproject.org/api/v2/doc/doc?query=bitcoin%20BTC&mode=ArtList&format=json&maxrecords=15&sort=DateDesc';
  const j = await (await get(url)).json() as { articles?: Array<{ title: string; url: string; domain?: string; seendate?: string }> };
  return (j.articles || []).slice(0, 15).map((a) => ({
    headline: a.title,
    url: a.url,
    src: a.domain || 'GDELT',
    date: a.seendate,
    sent: scoreSentiment(a.title),
  }));
}

async function fetchExa(apiKey: string): Promise<NewsItem[]> {
  const r = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      query: 'Bitcoin BTC price market news today',
      numResults: 10,
      type: 'auto',
      category: 'news',
      startPublishedDate: new Date(Date.now() - 86400_000).toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`Exa HTTP ${r.status}`);
  const j = await r.json() as { results?: Array<{ title: string; url: string; publishedDate?: string }> };
  return (j.results || []).map((x) => ({
    headline: x.title,
    url: x.url,
    src: (() => { try { return new URL(x.url).hostname.replace(/^www\./, ''); } catch { return 'Exa'; } })(),
    date: x.publishedDate,
    sent: scoreSentiment(x.title),
  }));
}

async function fetchFearGreed() {
  const j = await (await get('https://api.alternative.me/fng/?limit=2')).json() as {
    data?: Array<{ value: string; value_classification: string; timestamp: string }>;
  };
  const cur = j?.data?.[0];
  if (!cur) throw new Error('no FG data');
  return {
    value: parseInt(cur.value, 10),
    label: cur.value_classification,
    prev: j.data![1] ? parseInt(j.data![1].value, 10) : null,
    srcTs: parseInt(cur.timestamp, 10) * 1000,
    ts: Date.now(),
    _updatedMs: Date.now(),
  };
}

// ---- main export ----

export async function runEnrichmentCron(env: Env): Promise<void> {
  console.log('[cron:enrichment] start');

  // ---- News ----
  const exaKey =
    env.EXA_API_KEY && env.EXA_API_KEY.length > 20 ? env.EXA_API_KEY : null;

  const tasks: Array<[string, Promise<NewsItem[]>]> = [
    ['CryptoPanic', fetchCryptoPanic()],
    ['GDELT', fetchGdelt()],
  ];
  if (exaKey) tasks.push(['Exa', fetchExa(exaKey)]);

  const settled = await Promise.allSettled(tasks.map(([, p]) => p));
  const sources: string[] = [];
  let merged: NewsItem[] = [];

  settled.forEach((res, i) => {
    const name = tasks[i][0];
    if (res.status === 'fulfilled' && res.value.length) {
      console.log(`[cron:enrichment] ${name}: ${res.value.length} items`);
      sources.push(name);
      merged = merged.concat(res.value);
    } else {
      console.error(`[cron:enrichment] ${name} failed:`, (res as PromiseRejectedResult).reason?.message || 'empty');
    }
  });

  if (merged.length) {
    const news = {
      items: dedupeNews(merged).slice(0, 20),
      ts: Date.now(),
      source: sources.join('+'),
      _updatedMs: Date.now(),
    };
    await env.BTC_CACHE.put('enrichment:news', JSON.stringify(news), {
      expirationTtl: 7200, // 2 jam
    });
    console.log(`[cron:enrichment] wrote news (${news.items.length} items from ${news.source})`);
  } else {
    console.warn('[cron:enrichment] all news sources failed — keeping existing KV entry');
  }

  // ---- Fear & Greed ----
  try {
    const fg = await fetchFearGreed();
    await env.BTC_CACHE.put('enrichment:fg', JSON.stringify(fg), {
      expirationTtl: 7200,
    });
    console.log(`[cron:enrichment] wrote fg (${fg.value} · ${fg.label})`);
  } catch (e) {
    console.error('[cron:enrichment] fear/greed failed:', (e as Error).message);
  }

  console.log('[cron:enrichment] done');
}
