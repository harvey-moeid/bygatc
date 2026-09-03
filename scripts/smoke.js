#!/usr/bin/env node
/**
 * scripts/smoke.js  (v4.1)
 * =====================================================================
 * Post-fetch sanity gate run by the GH Actions workflow before committing.
 * Validates that any snapshot files present are well-formed and in sane
 * ranges, so a parser regression can never publish garbage to the live
 * dashboard. Missing files are tolerated (sources can fail independently);
 * malformed files are not.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
let failures = 0;

function check(name, fn) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) { console.log(`[smoke] ${name}: absent (ok)`); return; }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errs = fn(j) || [];
    if (errs.length) { failures++; console.error(`[smoke] ${name}: FAIL — ${errs.join('; ')}`); }
    else console.log(`[smoke] ${name}: ok`);
  } catch (e) {
    failures++;
    console.error(`[smoke] ${name}: FAIL — unparseable JSON (${e.message})`);
  }
}

check('kronos.json', j => {
  const errs = [];
  if (typeof j.upside !== 'number' || j.upside < 0 || j.upside > 100) errs.push(`upside out of range: ${j.upside}`);
  if (typeof j.volAmp !== 'number' || j.volAmp < 0 || j.volAmp > 100) errs.push(`volAmp out of range: ${j.volAmp}`);
  if (!j._updatedMs) errs.push('missing _updatedMs');
  if (j._updatedMs && Date.now() - j._updatedMs > 6 * 3600_000) errs.push('snapshot older than 6h');
  return errs;
});

check('news.json', j => {
  const errs = [];
  if (!Array.isArray(j.items) || !j.items.length) errs.push('items empty/absent');
  if (!j._updatedMs) errs.push('missing _updatedMs');
  for (const it of j.items || []) {
    if (!it.headline) { errs.push('item without headline'); break; }
    if (it.url && !/^https?:\/\//.test(it.url)) { errs.push(`bad url: ${it.url}`); break; }
    if (!['pos', 'neg', 'neu'].includes(it.sent)) { errs.push(`bad sent: ${it.sent}`); break; }
  }
  // dedupe regression check
  const keys = (j.items || []).map(i => (i.headline || '').toLowerCase().slice(0, 60));
  if (new Set(keys).size !== keys.length) errs.push('duplicate headlines survived dedupe');
  return errs;
});

check('fg.json', j => {
  const errs = [];
  if (typeof j.value !== 'number' || j.value < 0 || j.value > 100) errs.push(`value out of range: ${j.value}`);
  if (!j._updatedMs) errs.push('missing _updatedMs');
  return errs;
});

if (failures) { console.error(`[smoke] ${failures} file(s) failed validation`); process.exit(1); }
console.log('[smoke] all present snapshots valid');
