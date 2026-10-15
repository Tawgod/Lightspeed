import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const source=fs.readFileSync('extension/product-scanner/review.js','utf8');
test('supplier reorder defaults general SKU',()=>{
  assert.match(source,/k==='sku' \? \(p\.sku\|\|capturedSupplierSku\)/);
  assert.match(source,/if\(k==='sku'\)employeeEditedGeneralSku=true/);
});
test('does not replace employee edited SKU or fuzzy-only results',()=>{
  assert.match(source,/if\(!employeeEditedGeneralSku\)/);
  assert.match(source,/matchingLightspeedSku\(result.matches,product\)/);
  assert.match(source,/distinct.size===1/);
  assert.match(source,/product\.supplierSku&&m\.supplierSku/);
});
test('no product write endpoint enabled',()=>{
  assert.doesNotMatch(source,/\/products\/create|\/products\/update/);
  assert.match(source,/No Lightspeed changes will be made/);
});
