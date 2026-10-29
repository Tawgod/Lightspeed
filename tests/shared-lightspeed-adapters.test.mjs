import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaffLightspeedPolicy, employeeRequestPrincipal } from '../services/lightspeed/staffAdapter.js';
import { createLegacyLightspeedReadAdapter } from '../services/lightspeed/legacyReadAdapter.js';
import { createAuditedLightspeedMutation } from '../services/lightspeed/mutations.js';
import { createLightspeedIdempotency } from '../services/lightspeed/idempotency.js';
import { createLightspeedAudit } from '../services/lightspeed/audit.js';
import { createLightspeedPolicy } from '../services/lightspeed/policy.js';

test('staff adapter uses actual verified Timeclock request rather than supplied actor fields', async () => {
  const seen = [];
  const policy = createStaffLightspeedPolicy({
    verifyEmployeeRequest: async request => {
      seen.push(request);
      if (request.get('authorization') !== 'Bearer valid') throw Error('invalid session');
      return { id: 'TIME-101', name: 'Test Employee', role: 'staff' };
    },
    checkPermission: async ({ identity, operation, mode }) =>
      identity.id === 'TIME-101' && operation === 'products.read' && mode === 'read'
  });
  const req = { get: name => name === 'authorization' ? 'Bearer valid' : '' };
  const principal = employeeRequestPrincipal(req);
  const allowed = await policy.authorize({ principal, operation: 'products.read', mode: 'read' });
  assert.equal(allowed.identityId, 'TIME-101');
  assert.equal(seen[0], req);
  await assert.rejects(policy.authorize({
    principal: { type: 'employee', id: 'TIME-101', active: true },
    operation: 'products.read', mode: 'read'
  }), e => e.code === 'LIGHTSPEED_FORBIDDEN');
  const fake = { get: name => name === 'authorization' ? 'Bearer fake' : '' };
  await assert.rejects(policy.authorize({
    principal: employeeRequestPrincipal(fake), operation: 'products.read', mode: 'read'
  }), e => e.code === 'LIGHTSPEED_FORBIDDEN');
});

test('compatibility adapter preserves the exact legacy read route and response envelope', async () => {
  const calls = [];
  const envelope = { data: { id: 'S1' } };
  const read = createLegacyLightspeedReadAdapter({
    transport: { request: async path => { calls.push(path); return envelope; } }
  });
  const methods = [
    ['getSale', 'sale-1', '/api/2.0/sales/sale-1'],
    ['searchSalesByInvoiceNumber', '00123', '/api/2.0/search?type=sales&invoice_number=00123&page_size=20'],
    ['searchSalesByCustomer', 'C1', '/api/2.0/search?type=sales&customer_id=C1&page_size=1000'],
    ['searchSalesByState', 'open', '/api/2.0/search?type=sales&state=open&page_size=1000'],
    ['getFulfillmentsForSale', 'S1', '/api/2.0/fulfillments?sale_id=S1'],
    ['getCustomer', 'C1', '/api/2.0/customers/C1'],
    ['getProduct', 'P1', '/api/2.0/products/P1'],
    ['getStoreCredit', 'C1', '/api/2026-07/store_credits/C1']
  ];
  for (const [method, arg, expected] of methods) {
    assert.equal(await read[method](arg), envelope);
    assert.equal(calls.at(-1), expected);
  }
  assert.equal('createSale' in read, false);
  assert.equal('updateSale' in read, false);
  assert.equal('createStoreCreditTransaction' in read, false);
});

test('mutation pipeline refuses writes when policy rejects; records verified success and replay', async () => {
  let writes = 0;
  const auditEvents = [];
  const stored = new Map();
  const audit = createLightspeedAudit({ append: async event => {
    auditEvents.push(event);
    return { id: String(auditEvents.length) };
  } });
  const idempotency = createLightspeedIdempotency({ store: {
    async claim({scope,key,fingerprint}) {
      const k = scope + ':' + key;
      const saved = stored.get(k);
      if (saved) {
        if (saved.fingerprint !== fingerprint) return {state:'conflict'};
        if (saved.verified) return {state:'replay',verified:true,fingerprint,result:saved.result};
        return {state:'unknown'};
      }
      stored.set(k, { fingerprint }); return {state:'claimed',lease:'test-lease'};
    },
    async complete({scope,key,fingerprint,result}) {stored.set(scope + ':' + key,{fingerprint,verified:true,result});},
    async markUnknown() { throw Error('No failure expected'); }
  } });
  const disabled = createAuditedLightspeedMutation({
    policy: createLightspeedPolicy({
      verifyEmployee: async () => ({id:'E1',active:true}),
      checkPermission: async () => true
    }),audit,idempotency,tenant:'isolated-test',environment:'test'
  });
  const input = {
    principal: {type:'employee'}, operation:'products.create', tenant:'isolated-test',
    correlationId:'trace-001',key:'inventory-test-001',
    entityType:'product', payload:{sku:'000101'},
    execute:async () => {writes++;return{id:'P1'};},
    verifyReadback:async result => result.id === 'P1'
  };
  await assert.rejects(disabled.run(input),e => e.code === 'LIGHTSPEED_FORBIDDEN');
  assert.equal(writes,0);
  assert.equal(auditEvents.length,0);
  const enabled = createAuditedLightspeedMutation({
    policy: createLightspeedPolicy({
      verifyEmployee: async () => ({id:'E1',active:true}),
      checkPermission: async () => true,
      writesAllowed:true
    }),audit,idempotency,tenant:'isolated-test',environment:'test'
  });
  await enabled.run(input);
  const replay = await enabled.run(input);
  assert.equal(replay.replayed,true);
  assert.equal(writes,1);
  assert.deepEqual(auditEvents.map(x=>x.stage),['requested','verified','requested','verified']);
  assert.ok(auditEvents.every(e=>e.actorId==='E1' && e.fingerprint.length===64));
});

test('audit must commit before mutation is attempted', async () => {
  let calls=0;
  const pipeline=createAuditedLightspeedMutation({
    policy:createLightspeedPolicy({verifyService:async () => ({id:'svc',active:true}),
      checkPermission:async () => true,writesAllowed:true}),
    audit:createLightspeedAudit({append:async () => {throw Error('offline');}}),
    tenant:'testshop', environment:'test',
    idempotency:createLightspeedIdempotency({store:{
      async claim(){calls++;return{state:'claimed',lease:'test'};},
      async complete(){},async markUnknown(){}
    }})
  });
  await assert.rejects(pipeline.run({
    principal:{type:'service'},operation:'products.create',
    correlationId:'trace',key:'example-test-01',entityType:'product',payload:{sku:'0001'},
    execute:async () => {calls++;return{id:'P1'};},verifyReadback:async () => true
  }),e=>e.code==='LIGHTSPEED_AUDIT_UNAVAILABLE');
  assert.equal(calls,0);
});
