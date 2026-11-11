import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CORE_OPERATIONS_BROWSER_CALLERS} from '../services/security/coreOperationsBrowserCallerInventory.js';

const expectedSources = ['special-orders-client.js','preorders-client.js',
  'gw-preorders-client.js','ordering-client.js'];

function observed(source) {
  const code=readFileSync(new URL('../'+source,import.meta.url),'utf8');
  const references=[...code.matchAll(/\bapi\s*\+\s*(['"`])([^'"`]+)\1/g)]
    .map(match=>match[2]);
  return {code, prefixes:[...new Set(references)].sort()};
}

test('every browser web client is represented and its literal API prefixes match current source', () => {
  assert.ok(Object.isFrozen(CORE_OPERATIONS_BROWSER_CALLERS));
  assert.deepEqual(CORE_OPERATIONS_BROWSER_CALLERS.map(x=>x.source),expectedSources);
  for(const record of CORE_OPERATIONS_BROWSER_CALLERS){
    assert.ok(Object.isFrozen(record));
    assert.ok(Object.isFrozen(record.literalPrefixes));
    assert.equal(record.kind,'browser-employee');
    assert.equal(record.apiBase,'/api/special-orders');
    assert.equal(record.review,'pending');
    assert.deepEqual(record.literalPrefixes,observed(record.source).prefixes,
      'Changed web API path source: review and update staff permission mapping for '+record.source);
  }
});

test('all four browser clients still use the common Timeclock-backed login helper, not a new independent login', () => {
  for(const source of expectedSources) {
    const {code}=observed(source);
    assert.match(code,/HCStaffAuth/);
    assert.match(code,/authHeaders/);
  }
});

test('known sensitive browser-side calls remain visible for separate operation and factor review',()=>{
  const records=new Map(CORE_OPERATIONS_BROWSER_CALLERS.map(r=>[r.source,r.literalPrefixes]));
  assert.ok(records.get('special-orders-client.js').includes('/products/create-lightspeed'));
  assert.ok(records.get('special-orders-client.js').includes('/customers/create-lightspeed'));
  assert.ok(records.get('special-orders-client.js').includes('/supplier-orders/'));
  assert.ok(records.get('gw-preorders-client.js').includes('/preorders/gw/campaigns/'));
  assert.ok(records.get('ordering-client.js').includes('/ordering/lightspeed-purchase-orders/'));
  assert.ok(records.get('ordering-client.js').includes('/notifications/'));
});

test('literal fragments are NOT complete route templates or server-side access grants',()=>{
  const entries=CORE_OPERATIONS_BROWSER_CALLERS.flatMap(x=>x.literalPrefixes);
  assert.ok(entries.some(x=>x==='/items/'));
  assert.ok(entries.some(x=>x.includes('?')));
  assert.ok(entries.every(x=>x.startsWith('/')&&!x.startsWith('//')));
  assert.ok(CORE_OPERATIONS_BROWSER_CALLERS.every(x=>x.review==='pending'));
});
