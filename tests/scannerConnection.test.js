import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const review=fs.readFileSync(new URL('../extension/product-scanner/review.js',import.meta.url),'utf8');
const manifest=JSON.parse(fs.readFileSync(new URL('../extension/manifest.json',import.meta.url),'utf8'));
const timeclock=fs.readFileSync(new URL('../timeclock/server.js',import.meta.url),'utf8');

test('gateway is opt-in and co-located with Special Orders backend',()=>{
  assert.match(server,/process\.env\.SCANNER_ENABLED==='true'/);
  assert.match(server,/app\.use\('\/api\/scanner'/);
  assert.match(server,/process\.env\.SPECIAL_ORDERS_ADMIN_KEY/);
  assert.match(server,/createScannerLoginLimiter/);
});
test('extension uses restricted gateway and has matching host permission',()=>{
  assert.equal(manifest.version,'0.3.19');
  assert.ok(manifest.host_permissions.includes('https://special-orders-test-production.up.railway.app/*'));
  assert.match(review,/special-orders-test-production\.up\.railway\.app\/api\/scanner/);
  assert.doesNotMatch(review,/SPECIAL_ORDERS_ADMIN_KEY|SCANNER_SERVICE_SECRET/);
});
test('Timeclock rejects public access to internal PIN verifier',()=>{
  assert.match(timeclock,/app\.post\('\/api\/timeclock\/integrations\/scanner\/verify-pin'/);
  assert.match(timeclock,/if\(!scannerServiceAuthorized\(req\)\)return res\.status\(403\)/);
  assert.match(timeclock,/scanner_can_lookup BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(timeclock,/scanner_can_approve BOOLEAN NOT NULL DEFAULT FALSE/);
});
