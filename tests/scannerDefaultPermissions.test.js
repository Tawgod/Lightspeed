import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const timeclock=fs.readFileSync(new URL('../timeclock/server.js',import.meta.url),'utf8');
const review=fs.readFileSync(new URL('../extension/product-scanner/review.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../extension/product-scanner/review.html',import.meta.url),'utf8');

test('new Timeclock employees may look up but cannot approve by default',()=>{
  assert.match(timeclock,/scanner_can_lookup BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(timeclock,/scanner_can_approve BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(timeclock,/ALTER COLUMN scanner_can_lookup SET DEFAULT TRUE/);
});
test('scanner sign-in does not persist PIN or session in Chrome storage',()=>{
  assert.match(html,/id="employee-pin"/);
  assert.match(review,/SCANNER_API\+'\/session'/);
  assert.match(review,/SCANNER_API\+'\/matches'/);
  assert.doesNotMatch(review,/chrome\.storage\.(local|sync)\.set\([^)]*(pin|token|scannerSession)/);
  assert.match(review,/scannerSession=null/);
});
test('extension still keeps create/update disabled',()=>{
  assert.match(html,/<button type="button" id="create-item" disabled>Prepare Create Item<\/button>/);
  assert.doesNotMatch(html,/id="product-create-submit"|id="product-update-submit"/);
  assert.match(review,/No Lightspeed changes will be made|No Lightspeed changes|No Lightspeed changes will be made/i);
});
