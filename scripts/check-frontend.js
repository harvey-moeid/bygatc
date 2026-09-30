#!/usr/bin/env node
/**
 * Frontend smoke test. No dependencies, ASCII-only on purpose (see
 * scripts/check-encoding.js).
 *
 * Checks:
 *   1. every apps/frontend/src/*.js compiles (syntax only, nothing is run)
 *   2. every local href/src in apps/frontend/*.html points to a real file
 *      (tags with onerror=, e.g. the optional src/config.js, are skipped)
 *   3. every apps/frontend/data/*.json is valid JSON
 *   4. data contract: the fields charts.html / charts-page.js read exist
 *      in noctua.json, fg.json and vol_seasonality.json
 *   5. every element id that charts-page.js looks up exists in charts.html
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'apps', 'frontend');
const errors = [];
let checks = 0;

function check(cond, msg) { checks++; if (!cond) errors.push(msg); }
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, lo, hi) => isNum(v) && v >= lo && v <= hi;

function loadJson(rel) {
  try {
    const j = JSON.parse(read(rel));
    checks++;
    return j;
  } catch (e) {
    checks++;
    errors.push(rel + ': invalid JSON (' + e.message + ')');
    return null;
  }
}

// 1) JS syntax ---------------------------------------------------------
const srcDir = path.join(ROOT, 'src');
for (const f of fs.readdirSync(srcDir).filter(n => n.endsWith('.js'))) {
  try {
    new vm.Script(read('src/' + f), { filename: f });
    checks++;
  } catch (e) {
    checks++;
    errors.push('src/' + f + ': syntax error (' + e.message + ')');
  }
}

// 2) local references in HTML -------------------------------------------
const SKIP_PREFIXES = ['http:', 'https:', 'data:', 'mailto:', 'javascript:', '#', '/api/'];
const attrRe = /(href|src)="([^"]+)"/g;
for (const page of fs.readdirSync(ROOT).filter(n => n.endsWith('.html'))) {
  const html = read(page);
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const url = m[2];
    if (SKIP_PREFIXES.some(p => url.startsWith(p))) continue;
    const tagStart = html.lastIndexOf('<', m.index);
    const tagEnd = html.indexOf('>', m.index);
    if (html.slice(tagStart, tagEnd).includes('onerror=')) continue;
    const rel = url.split('#')[0].split('?')[0];
    if (!rel) continue;
    check(exists(rel), page + ': ' + m[1] + '="' + url + '" does not exist');
  }
}

// 3) data files parse -----------------------------------------------------
const dataDir = path.join(ROOT, 'data');
if (fs.existsSync(dataDir)) {
  for (const f of fs.readdirSync(dataDir).filter(n => n.endsWith('.json'))) loadJson('data/' + f);
}

// 4) data contract used by the charts page -------------------------------
const noctua = exists('data/noctua.json') ? loadJson('data/noctua.json') : null;
if (noctua) {
  const curves = noctua.barrier_curves || {};
  const up = curves.up;
  const dn = curves.dn;
  check(Array.isArray(up) && up.length > 0, 'noctua.json: barrier_curves.up missing or empty');
  check(Array.isArray(dn) && dn.length > 0, 'noctua.json: barrier_curves.dn missing or empty');
  if (Array.isArray(up) && Array.isArray(dn)) {
    check(up.length === dn.length, 'noctua.json: barrier_curves.up and .dn must have the same length');
    for (const p of up.concat(dn)) {
      check(isNum(p.pct) && isNum(p.price) && inRange(p.touch_prob, 0, 1),
        'noctua.json: bad barrier point ' + JSON.stringify(p));
    }
  }
  const safe = noctua.safe_levels;
  check(Array.isArray(safe) && safe.length > 0, 'noctua.json: safe_levels missing or empty');
  if (Array.isArray(safe)) {
    for (const s of safe) {
      check(inRange(s.alpha, 0, 1) && isNum(s.call_pct) && isNum(s.put_pct) && isNum(s.call_strike) && isNum(s.put_strike),
        'noctua.json: bad safe level ' + JSON.stringify(s));
    }
  }
  check(inRange(noctua.p_vol_amplify, 0, 1), 'noctua.json: p_vol_amplify must be a number in [0,1]');
  check(isNum(noctua.spot) && noctua.spot > 0, 'noctua.json: spot must be a positive number');
}

const fg = exists('data/fg.json') ? loadJson('data/fg.json') : null;
if (fg) {
  check(inRange(fg.value, 0, 100), 'fg.json: value must be a number in [0,100]');
}

const season = exists('data/vol_seasonality.json') ? loadJson('data/vol_seasonality.json') : null;
if (season) {
  check(season.yearlyRv && Object.keys(season.yearlyRv).length > 0, 'vol_seasonality.json: yearlyRv missing or empty');
  check(season.monthRv && Object.keys(season.monthRv).length === 12, 'vol_seasonality.json: monthRv must have 12 entries');
  check(season.dowDailyRv && Object.keys(season.dowDailyRv).length === 7, 'vol_seasonality.json: dowDailyRv must have 7 entries');
  check(season.hourVolBpsPostEtf && Object.keys(season.hourVolBpsPostEtf).length === 24, 'vol_seasonality.json: hourVolBpsPostEtf must have 24 entries');
}

// 5) element ids used by charts-page.js exist in charts.html ---------------
if (exists('src/charts-page.js') && exists('charts.html')) {
  const js = read('src/charts-page.js');
  const html = read('charts.html');
  const idRe = /(?:\$|mk|setEmpty|clearEmpty|barChart)\('([A-Za-z0-9_]+)'/g;
  const ids = new Set();
  let m;
  while ((m = idRe.exec(js)) !== null) ids.add(m[1]);
  check(ids.size > 0, 'charts-page.js: no element ids found (id regex out of date?)');
  for (const id of ids) {
    check(html.includes('id="' + id + '"'), 'charts.html: missing element id="' + id + '" (used by charts-page.js)');
  }
}

// report ------------------------------------------------------------------
if (errors.length) {
  console.error('[frontend] FAIL - ' + errors.length + ' problem(s) in ' + checks + ' checks:');
  errors.forEach(e => console.error('  - ' + e));
  process.exit(1);
}
console.log('[frontend] OK - ' + checks + ' checks passed');
