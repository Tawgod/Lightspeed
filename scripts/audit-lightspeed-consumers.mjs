// Read-only source inventory plus optional PR-level enforcement for NEW direct Lightspeed clients.
// The legacy direct clients are grandfathered temporarily; do not silently expand them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const IGNORED = new Set(['.git', 'node_modules', 'tests', '.github', 'extension', 'Templates']);
const allowedDirectWriters = [
  /^services\/lightspeed\/client\.js$/,
  /^services\/scannerIsolatedTestWriter\.js$/,
  /^.*(?:rms|migration|importer).*$/i
];
const sourceFile = p => /\.(?:m?js|cjs|ts|py)$/.test(p);

function walk(dir = '') {
  const results = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED.has(entry.name)) results.push(...walk(rel));
    else if (entry.isFile() && sourceFile(rel)) results.push(rel);
  }
  return results;
}
const hostPattern = /retail\.lightspeed\.app|LIGHTSPEED_(?:TOKEN|DOMAIN)|HC_LIGHTSPEED_(?:TOKEN|DOMAIN)/gi;
const inventory = walk().map(filename => {
  const content = fs.readFileSync(path.join(ROOT, filename), 'utf8');
  const matches = content.match(hostPattern) || [];
  return { file: filename, directAccessIndicators: matches.length,
    category: allowedDirectWriters.some(pattern => pattern.test(filename)) ? 'exception-or-transport' : 'legacy-or-consumer' };
}).filter(row => row.directAccessIndicators > 0);
console.log(JSON.stringify({ scannedAt: new Date().toISOString(), inventory }, null, 2));

if (process.argv.includes('--check-new')) {
  // GitHub Actions checks only new/additional direct calls in a PR, not existing legacy debt.
  const base = process.env.LIGHTSpeed_AUDIT_BASE || 'origin/integration/hobby-corner-consolidation';
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--unified=0', base + '...HEAD', '--', '*.js', '*.mjs', '*.cjs', '*.ts', '*.py'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024
    });
  } catch {
    console.error('Base comparison unavailable. Architecture check fails closed.');
    process.exit(2);
  }
  let currentFile = null, failures = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) { currentFile = line.slice(6); continue; }
    if (!line.startsWith('+') || line.startsWith('+++') || !currentFile) continue;
    if (allowedDirectWriters.some(pattern => pattern.test(currentFile))) continue;
    if (hostPattern.test(line) || /fetch\s*\([^)]*\/api\/(?:2\.0|20\d\d-\d\d)/i.test(line)) {
      failures.push({ file: currentFile, addedLine: line.slice(1, 160) });
    }
    hostPattern.lastIndex = 0;
  }
  if (failures.length) {
    console.error('New raw Lightspeed access must use shared services:', JSON.stringify(failures, null, 2));
    process.exit(1);
  }
  console.log('No newly introduced raw Lightspeed access outside approved transport/isolated exceptions.');
}
