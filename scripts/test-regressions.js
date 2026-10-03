#!/usr/bin/env node
// Run with: node --test scripts/test-regressions.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(ROOT, 'apps/worker/package.json'));
const ts = workerRequire('typescript');

// Execute the real TypeScript modules with an isolated fetch mock.
function workerModule(relative, fetch) {
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const context = vm.createContext({ fetch, AbortSignal, console: { log() {}, warn() {}, error() {} }, Date });
    const localRequire = name => name.startsWith('.')
      ? load(path.resolve(path.dirname(filename), name + '.ts')) : workerRequire(name);
    vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(localRequire, module, module.exports);
    return module.exports;
  }
  return load(path.join(ROOT, 'apps/worker/src', relative));
}
function kv(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { values, get: async key => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value), delete: async key => values.delete(key) };
}

for (const side of ['upper', 'lower']) {
  test(`price ${side}: failed delivery retries, successful delivery deduplicates`, async () => {
    let attempts = 0;
    const { runPriceAlertCron } = workerModule('cron/priceAlert.ts', async () => {
      attempts++;
      return new Response(null, { status: attempts === 1 ? 503 : 204 });
    });
    const cache = kv({ 'alert:price_config': JSON.stringify({ [side]: 100 }),
      'market:price': JSON.stringify({ price: side === 'upper' ? 110 : 90, ts: Date.now() }) });
    const env = { BTC_CACHE: cache, DISCORD_WEBHOOK_URL: 'https://example.invalid/mock' };
    await runPriceAlertCron(env);
    assert.equal(cache.values.has('alert:price_state'), false);
    await runPriceAlertCron(env);
    await runPriceAlertCron(env);
    assert.equal(attempts, 2);
    assert.equal(JSON.parse(cache.values.get('alert:price_state'))[side === 'upper' ? 'above' : 'below'], true);
  });
}

test('volatility delivery retries without losing previous delivered regime', async () => {
  let attempts = 0;
  const { checkFuturesVolAlert } = workerModule('lib/futuresSignal.ts', async () => {
    attempts++;
    return new Response(null, { status: attempts === 1 ? 503 : 204 });
  });
  const cache = kv({ 'alert:vol_regime_state': '{"tier":"calm"}' });
  const env = { BTC_CACHE: cache, DISCORD_WEBHOOK_URL: 'https://example.invalid/mock' };
  await checkFuturesVolAlert(env, { p_vol_amplify: 0.8 });
  assert.equal(JSON.parse(cache.values.get('alert:vol_regime_state')).tier, 'calm');
  await checkFuturesVolAlert(env, { p_vol_amplify: 0.8 });
  await checkFuturesVolAlert(env, { p_vol_amplify: 0.8 });
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(cache.values.get('alert:vol_regime_state')).tier, 'high');
});

test('environment thresholds apply only when KV configuration is absent', async () => {
  let attempts = 0;
  const { runPriceAlertCron } = workerModule('cron/priceAlert.ts', async () => {
    attempts++; return new Response(null, { status: 204 });
  });
  for (const config of ['{"lower":50}', '{}', null]) {
    const cache = kv({ 'market:price': JSON.stringify({ price: 110, ts: Date.now() }) });
    if (config !== null) cache.values.set('alert:price_config', config);
    await runPriceAlertCron({ BTC_CACHE: cache, ALERT_PRICE_UPPER: '100', DISCORD_WEBHOOK_URL: 'https://example.invalid/mock' });
    assert.equal(attempts, config === null ? 1 : 0);
  }
});

test('config API can disable all alerts and rejects non-object bodies', async () => {
  const { alertsRoutes } = workerModule('routes/alerts.ts', async () => { throw Error('unexpected fetch'); });
  const cache = kv({ 'alert:price_state': '{"above":true}' });
  const env = { BTC_CACHE: cache, ALERTS_SECRET: 'test-only' };
  for (const body of ['{}', 'null', '[]', '42']) {
    const response = await alertsRoutes.request('/config', {
      method: 'PUT', headers: { Authorization: 'Bearer test-only', 'Content-Type': 'application/json' }, body,
    }, env);
    assert.equal(response.status, body === '{}' ? 200 : 400);
  }
  assert.equal(cache.values.get('alert:price_config'), '{}');
  assert.equal(cache.values.has('alert:price_state'), false);
});

function frontend(fetch, store = new Map()) {
  const context = vm.createContext({ fetch, AbortSignal, Date,
    console: { log() {}, warn() {}, error() {} }, window: {},
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps/frontend/src/data.js'), 'utf8'), context);
  return { context, store, run: code => vm.runInContext(code, context) };
}

test('stale response and legacy cache cannot supply options for trading', async () => {
  const rows = [{ expiry: '31DEC99', strike: 100, type: 'C', markIv: 40 }];
  const store = new Map(['options', 'options_stale'].map(key => ['btc_cache_v4_' + key,
    JSON.stringify({ data: rows, expires: Date.now() + 86400000 })]));
  const front = frontend(async () => new Response(JSON.stringify(rows), {
    headers: { 'X-Data-Freshness': 'stale' },
  }), store);
  assert.equal(await front.run('DataLayer.fetchOptions()'), null);
  assert.equal(store.has('btc_cache_v4_options_fresh'), false);
});

test('fresh options expire after ten minutes; network failure does not use stale cache', async () => {
  let calls = 0;
  const front = frontend(async () => {
    calls++;
    if (calls > 1) throw Error('offline');
    return new Response('[{"strike":100}]');
  });
  assert.equal((await front.run('DataLayer.fetchOptions()'))[0].strike, 100);
  await front.run('DataLayer.fetchOptions()');
  assert.equal(calls, 1);
  const key = 'btc_cache_v4_options_fresh';
  const cached = JSON.parse(front.store.get(key));
  assert.ok(cached.expires - Date.now() <= 600000);
  cached.expires = 0;
  front.store.set(key, JSON.stringify(cached));
  assert.equal(await front.run('DataLayer.fetchOptions()'), null);
});

test('refresh failure clears the previous trading plan and derived option values', async () => {
  const front = frontend(async () => { throw Error('offline'); });
  Object.assign(front.context, {
    document: { getElementById: () => null },
    UI: new Proxy({}, { get: () => () => {} }), Charts: {},
    setTimeout() {}, setInterval() {},
  });
  // Keep unrelated market requests out of this orchestrator regression.
  front.run(`
    DataLayer.fetchPrice = async () => ({ price: 100 });
    DataLayer.fetchHourly = async () => [];
    DataLayer.fetchDaily = async () => [];
    DataLayer.fetchFearGreed = async () => null;
    DataLayer.fetchOptions = async () => null;
    DataLayer.fetchBGTC = async () => null;
    DataLayer.fetchFunding = async () => null;
    DataLayer.fetchNewsSentiment = async () => ({ items: [] });
  `);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps/frontend/src/main.js'), 'utf8'), front.context);
  await new Promise(resolve => setImmediate(resolve));
  front.run(`Object.assign(state, {
    retailPlan: { ok: true }, atmInfo: { atmIv: 40 },
    regime: { allowTrade: true, ratio: 1, sizing: 1 }, hv20: { annualised: 40 }
  })`);
  await front.run('refreshAll()');
  for (const field of ['retailPlan', 'atmInfo', 'regime', 'hv20']) {
    assert.equal(front.run('state.' + field), null);
  }
  assert.equal(front.run('state.decision.verdict'), 'NO-TRADE');
});
