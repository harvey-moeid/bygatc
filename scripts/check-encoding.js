#!/usr/bin/env node
/**
 * Reject UTF-8 mojibake before frontend/worker deployment.
 * This protects the repository from encoding regressions and U+FFFD.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const roots = ['README.md', 'docs', 'apps/frontend', 'apps/worker', 'scripts'];
const exts = new Set(['.md','.html','.css','.js','.ts','.json','.yml','.yaml','.toml','.py','.txt']);
const bad = /(?:â|Ã|Â|�)/;

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  if (st.isFile()) return [rel];
  return fs.readdirSync(abs, {withFileTypes:true}).flatMap(e => walk(path.join(rel, e.name)));
}

const files = [...new Set(roots.flatMap(walk))].filter(f => exts.has(path.extname(f)));
const failures = [];
for (const rel of files) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (bad.test(text)) failures.push(rel);
}
if (failures.length) {
  console.error('[encoding] FAIL - possible mojibake found:');
  failures.forEach(f => console.error('  ' + f));
  process.exit(1);
}
console.log(`[encoding] OK - scanned ${files.length} text files`);
