#!/usr/bin/env node
/**
 * Reject UTF-8 mojibake before frontend/worker deployment.
 * This protects the repository from encoding regressions and U+FFFD.
 *
 * Important: the scan must only cover repository source/content. Dependency
 * trees such as node_modules can contain intentionally encoded strings in
 * third-party localization files and must never make our CI fail.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const roots = ['README.md', 'docs', 'apps/frontend', 'apps/worker', 'scripts'];
const exts = new Set(['.md', '.html', '.css', '.js', '.ts', '.json', '.yml', '.yaml', '.toml', '.py', '.txt']);
const excludedDirs = new Set([
  'node_modules',
  '.git',
  '.wrangler',
  'dist',
  'build',
  'coverage',
]);
const bad = /[\u00e2\u00c3\u00c2\uFFFD]/;

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  if (st.isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) return [];
    return walk(path.join(rel, entry.name));
  });
}

const files = [...new Set(roots.flatMap(walk))]
  .filter((file) => exts.has(path.extname(file)));
const failures = [];

for (const rel of files) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (bad.test(text)) failures.push(rel);
}

if (failures.length) {
  console.error('[encoding] FAIL - possible mojibake found:');
  failures.forEach((file) => console.error('  ' + file));
  process.exit(1);
}

console.log(`[encoding] OK - scanned ${files.length} repository text files`);
