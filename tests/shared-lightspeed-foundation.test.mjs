import test from 'node:test';
import assert from 'node:assert/strict';
import { createLightspeedTransport, LightspeedTransportError } from '../services/lightspeed/client.js';
import { createLightspeedPolicy } from '../services/lightspeed/policy.js';
import { createLightspeedAudit } from '../services/lightspeed/audit.js';
import { createLightspeedIdempotency, fingerprintLightspeedPayload } from '../services/lightspeed/idempotency.js';

const response = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(data); }
});

test('transport validates server configuration and local API-only paths', async () => {
  assert.throws(() => createLightspeedTransport({ domain: 'bad.evil.com', token: 'secret' }));
  const client = createLightspeedTransport({ domain: 'test-shop', token: 'secret', fetchImpl: async () => response(200, {}) });
  await assert.rejects(client.request('https://attacker.invalid/api/2.0/sales'), TypeError);
  await assert.rejects(client.request('/api/../admin'), TypeError);
  await assert.rejects(client.request('/api/%2f%2fevil'), TypeError);
  await assert.rejects(client.request('/api/2.0/sales', { correlationId: 'bad\r\nid' }), TypeError);
});

test('transport has credential-safe headers and preserves API versioned paths', async () => {
  let captured;
  const client = createLightspeedTransport({
    domain: 'test-shop', token: 'example-token',
    fetchImpl: async (url, options) => { captured = { url, options }; return response(200, { data: { id: 'S1' } }); }
  });
  const result = await client.request('/api/2026-07/sales/ABC?expand=1', { correlationId: 'trace-123' });
  assert.equal(result.data.id, 'S1');
  assert.equal(captured.url, 'https://test-shop.retail.lightspeed.app/api/2026-07/sales/ABC?expand=1');
  assert.equal(captured.options.headers.Authorization, 'Bearer example-token');
  assert.equal(captured.options.headers['X-Request-ID'], 'trace-123');
  assert.equal(captured.options.redirect, 'error');
});

test('transport retries only safe reads', async () => {
  let attempts = 0;
  const client = createLightspeedTransport({
    domain: 'shop', token: 'token', readRetries: 1,
    fetchImpl: async () => { attempts++; return response(503, { error: 'unavailable' }); }
  });
  await assert.rejects(client.request('/api/2.0/products'), error => error instanceof LightspeedTransportError && error.retryable);
  assert.equal(attempts, 2);
  await assert.rejects(client.request('/api/2026-01/sales', { method: 'POST', body: { id: 'X' } }),
    error => error instanceof LightspeedTransportError && error.status === 503);
  assert.equal(attempts, 3);
});

test('transport marks uncertain write outcomes and never retries them', async () => {
  let attempts = 0;
  const client = createLightspeedTransport({
    domain: 'shop', token: 'token',
    fetchImpl: async () => { attempts++; throw Error('network outage with opaque details'); }
  });
  await assert.rejects(client.request('/api/2026-01/sales', { method: 'POST', body: { x: 1 } }),
    error => error.mayHaveWritten && !error.message.includes('opaque'));
  assert.equal(attempts, 1);
});

test('policy fails closed when authentication or permission is unavailable', async () => {
  assert.throws(() => createLightspeedPolicy({}), /permission/);
  const policy = createLightspeedPolicy({
    verifyEmployee: async () => ({ id: 'EMP1', active: true }),
    checkPermission: async () => false
  });
  await assert.rejects(policy.authorize({ principal: { type: 'employee' }, operation: 'products.read', mode: 'read' }),
    error => error.code === 'LIGHTSPEED_FORBIDDEN');
  await assert.rejects(policy.authorize({ principal: { type: 'service' }, operation: 'products.read', mode: 'read' }));
});

test('production writes require explicit authorization and both gates', async () => {
  const policy = createLightspeedPolicy({
    verifyEmployee: async () => ({ id: 'EMP1', active: true }),
    checkPermission: async () => true
  });
  const input = { principal: { type: 'employee' }, operation: 'products.create', mode: 'write' };
  await assert.rejects(policy.authorize(input));
  await assert.rejects(policy.authorize({ ...input, writeEnabled: true, productionWriteApproved: true }));
  const enabledPolicy = createLightspeedPolicy({
    verifyEmployee: async () => ({ id: 'EMP1', active: true }),
    checkPermission: async () => true,
    writesAllowed: true,
    productionWritesAllowed: true
  });
  const authorized = await enabledPolicy.authorize(input);
  assert.equal(authorized.identityId, 'EMP1');
  assert.equal(authorized.identityType, 'employee');
});

test('audit requires confirmed durable append and excludes raw business data', async () => {
  assert.throws(() => createLightspeedAudit({}), /append-only/);
  let saved;
  const audit = createLightspeedAudit({
    append: async event => { saved = event; return { id: 'EVT1' }; },
    now: () => '2026-10-29T00:00:00.000Z'
  });
  const receipt = await audit.record({
    stage: 'requested', correlationId: 'trace', operation: 'products.create',
    actorType: 'employee', actorId: 'E1', entityType: 'product', fingerprint: 'abc'
  });
  assert.equal(receipt.eventId, 'EVT1');
  assert.equal(saved.timestamp, '2026-10-29T00:00:00.000Z');
  assert.equal(Object.hasOwn(saved, 'payload'), false);
  const unavailable = createLightspeedAudit({ append: async () => { throw Error('db unavailable'); } });
  await assert.rejects(unavailable.record({
    stage: 'requested', correlationId: 'trace', operation: 'products.create',
    actorType: 'employee', actorId: 'E1', entityType: 'product', fingerprint: 'abc'
  }), error => error.code === 'LIGHTSPEED_AUDIT_UNAVAILABLE');
});

test('payload fingerprints are stable across object key order', () => {
  assert.equal(fingerprintLightspeedPayload({ b: 2, a: [1, { z: 'X', c: 3 }] }),
    fingerprintLightspeedPayload({ a: [1, { c: 3, z: 'X' }], b: 2 }));
  assert.notEqual(fingerprintLightspeedPayload({ sku: '00012' }), fingerprintLightspeedPayload({ sku: '12' }));
});

test('idempotency makes one attempt and permits only verified durable replay', async () => {
  let record;
  let writes = 0;
  const store = {
    async claim({ scope, key, fingerprint }) {
      if (!record) { record = { scope, key, fingerprint, state: 'pending' }; return { state: 'claimed', lease: 'lease1' }; }
      if (record.fingerprint !== fingerprint) return { state: 'conflict' };
      if (record.state === 'complete') return { state: 'replay', verified: true, fingerprint, result: record.result };
      return { state: 'unknown' };
    },
    async complete({ result }) { record = { ...record, state: 'complete', result }; },
    async markUnknown() { record = { ...record, state: 'unknown' }; }
  };
  const gate = createLightspeedIdempotency({ store });
  const args = {
    key: 'product-001', scope: 'products.create', payload: { sku: '001234' },
    execute: async () => { writes++; return { id: 'P1' }; },
    verifyReadback: async result => result.id === 'P1'
  };
  const one = await gate.run(args);
  const two = await gate.run(args);
  assert.equal(one.replayed, false);
  assert.equal(two.replayed, true);
  assert.equal(writes, 1);
  await assert.rejects(gate.run({ ...args, payload: { sku: '001235' } }),
    error => error.code === 'LIGHTSPEED_KEY_CONFLICT');
});

test('unverified mutation becomes unknown and cannot be automatically retried', async () => {
  let state = 'new', writes = 0;
  const store = {
    async claim() { return state === 'new' ? { state: 'claimed', lease: 'lease1' } : { state: 'unknown' }; },
    async complete() { throw Error('Must not complete unverified mutation.'); },
    async markUnknown() { state = 'unknown'; }
  };
  const gate = createLightspeedIdempotency({ store });
  const args = { key: 'product-001', scope: 'products.create', payload: { sku: '001' },
    execute: async () => { writes++; return { id: 'P1' }; }, verifyReadback: async () => false };
  await assert.rejects(gate.run(args), error => error.mayHaveWritten === true);
  await assert.rejects(gate.run(args), error => error.code === 'LIGHTSPEED_MUTATION_UNKNOWN');
  assert.equal(writes, 1);
});


test('customer read/search preserves Special Orders query shape and leading zeros', async () => {
  const { createLightspeedCustomersRead } = await import('../services/lightspeed/customers.js');
  const paths = [];
  const service = createLightspeedCustomersRead({
    transport: { async request(path) { paths.push(path); return { data: [{ id: 'C1' }] }; } }
  });
  assert.deepEqual(await service.search(''), []);
  assert.equal(paths.length, 0);
  assert.equal((await service.search('me@example.com'))[0].id, 'C1');
  assert.match(paths.at(-1), /\/api\/2026-04\/search\?type=customers&page_size=20&email=me%40example.com/);
  await service.search('0012345678');
  assert.match(paths.at(-1), /phone=0012345678/);
  await service.search('Jane Doe');
  assert.match(paths.at(-1), /first_name=Jane&last_name=Doe/);
  await service.get('C1');
  assert.equal(paths.at(-1), '/api/2.0/customers/C1');
});

test('customer read fails closed on incomplete remote search envelopes', async () => {
  const { createLightspeedCustomersRead } = await import('../services/lightspeed/customers.js');
  const service = createLightspeedCustomersRead({ transport: { async request() { return { warning: 'no results provided' }; } } });
  await assert.rejects(service.search('Jane'), error => error.code === 'LIGHTSPEED_INCOMPLETE_READ');
});

test('catalog category paths match legacy parent hierarchy and detect cycles', async () => {
  const { createLightspeedCatalogRead, normalizeProductCategories } = await import('../services/lightspeed/catalog.js');
  const entries = normalizeProductCategories({ data: [
    { id: '1', name: 'Board Games', parent_id: null },
    { id: '2', name: 'Strategy', parent_id: '1' },
    { id: '3', name: 'Two Player', parent_id: '2' }
  ] });
  assert.equal(entries.find(x => x.id === '3').path, 'Board Games › Strategy › Two Player');
  const cyc = normalizeProductCategories({ data: [
    { id: 'A', name: 'A', parent_id: 'B' }, { id: 'B', name: 'B', parent_id: 'A' }
  ] });
  assert.equal(cyc.length, 2);
  const seen = [];
  const service = createLightspeedCatalogRead({ transport: { async request(path) { seen.push(path); return { data: [] }; } } });
  await service.categories(); await service.suppliers(); await service.brands(); await service.tags();
  assert.equal(seen.length, 4);
  assert.equal(seen[0], '/api/2026-07/product_categories?page_size=1000&include=family');
});

test('shared product matching candidate retains Special Orders scoring and code zeros', async () => {
  const { scorePotentialMatch, matchTokens, normalizeMatchText } = await import('../services/lightspeed/productIdentity.js');
  assert.equal(normalizeMatchText('  ABC-001  '), 'abc 001');
  assert.deepEqual(matchTokens('The Box of Space Marines'), ['of', 'space', 'marines']);
  const exact = scorePotentialMatch('000123', { sku: '000123', name: 'Board Game' });
  const other = scorePotentialMatch('123', { sku: '000123', name: 'Board Game' });
  assert.equal(exact.score, 100);
  assert.ok(exact.reasons.includes('exact code'));
  assert.ok(other.score < exact.score);
});

test('transport rejects encoded traversal, fragments, and invalid size limits', async () => {
  assert.throws(() => createLightspeedTransport({ domain: 'shop', token: 'x', maxResponseBytes: 0 }), RangeError);
  const client = createLightspeedTransport({ domain: 'shop', token: 'x', fetchImpl: async () => response(200, {}) });
  await assert.rejects(client.request('/api/%2e%2e/anything'), TypeError);
  await assert.rejects(client.request('/api/2.0/%2Eadmin'), TypeError);
  await assert.rejects(client.request('/api/2.0/sales#unexpected-fragment'), TypeError);
  await assert.rejects(client.request('/api/2.0/sales\tbad'), TypeError);
});

test('all vendor HTTP errors on writes remain uncertain and writes are never retried', async () => {
  for (const status of [400, 409, 429, 500, 503]) {
    let calls = 0;
    const client = createLightspeedTransport({
      domain: 'shop', token: 'secret', readRetries: 3,
      fetchImpl: async () => { calls++; return response(status, { error: 'opaque' }); }
    });
    await assert.rejects(client.request('/api/2.0/sales', { method: 'POST', body: { sku: '000012' } }),
      error => error instanceof LightspeedTransportError &&
        error.status === status && error.mayHaveWritten === true && error.retryable === false);
    assert.equal(calls, 1, 'never automatically repeat a write');
  }
});

test('transport bounds responses and rejects non-JSON success without exposing raw contents', async () => {
  const tooLarge = createLightspeedTransport({
    domain: 'shop', token: 'secret', maxResponseBytes: 1024,
    fetchImpl: async () => new Response('x'.repeat(2048), { status: 200 })
  });
  await assert.rejects(tooLarge.request('/api/2.0/products'),
    error => error.code === 'LIGHTSPEED_RESPONSE');
  const invalidJson = createLightspeedTransport({
    domain: 'shop', token: 'secret',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>private upstream output</html>' })
  });
  await assert.rejects(invalidJson.request('/api/2.0/products'),
    error => error.code === 'LIGHTSPEED_RESPONSE_JSON' && !error.message.includes('private upstream'));
  await assert.rejects(invalidJson.request('/api/2.0/products', { method: 'POST', body: {} }),
    error => error.code === 'LIGHTSPEED_RESPONSE_JSON' && error.mayHaveWritten === true);
});

test('mutation fingerprints reject non-JSON and potentially ambiguous serialization', () => {
  const cycle = {}; cycle.self = cycle;
  const getter = {}; Object.defineProperty(getter, 'sku', { enumerable: true, get() { return '0001'; } });
  for (const item of [undefined, { sku: undefined }, { quantity: Infinity }, cycle,
    { when: new Date('2026-10-29') }, { access: getter }, [,'a'], { id: 1n }]) {
    assert.throws(() => fingerprintLightspeedPayload(item), TypeError);
  }
  assert.equal(fingerprintLightspeedPayload({ sku: '0001', cost: 2.5 }),
    fingerprintLightspeedPayload({ cost: 2.5, sku: '0001' }));
  assert.notEqual(fingerprintLightspeedPayload({ sku: '0001' }),
    fingerprintLightspeedPayload({ sku: '1' }));
});

test('mutation uses detached JSON snapshot and refuses a caller payload changed before execution', async () => {
  const payload = { sku: '0001' };
  let executions = 0, state = 'new';
  const store = {
    async claim() {
      if (state !== 'new') return { state: 'unknown' };
      state = 'pending';
      payload.sku = '0002'; // Simulate concurrent request mutation while awaiting the store.
      return { state: 'claimed', lease: 'lease' };
    },
    async complete() { throw Error('No write should have happened'); },
    async markUnknown() { state = 'unknown'; }
  };
  const gate = createLightspeedIdempotency({ store });
  await assert.rejects(gate.run({
    key: 'mutated-payload-001', scope: 'products.create', payload,
    execute: async () => { executions++; return { id: 'P1' }; },
    verifyReadback: async () => true
  }), error => error.code === 'LIGHTSPEED_MUTATION_UNKNOWN' && error.mayHaveWritten === false);
  assert.equal(executions, 0);
});

test('mutation marks uncertain if caller changes payload after vendor execution begins', async () => {
  const payload = { sku: '0001' };
  let unknown = false, persisted = false;
  const gate = createLightspeedIdempotency({ store: {
    async claim() { return { state: 'claimed', lease: 'lease' }; },
    async complete() { persisted = true; },
    async markUnknown() { unknown = true; }
  } });
  await assert.rejects(gate.run({
    key: 'mutation-race-001', scope: 'products.create', payload,
    execute: async approved => {
      assert.deepEqual(approved, { sku: '0001' });
      assert.notEqual(approved, payload);
      payload.sku = '0002';
      return { id: 'P1' };
    },
    verifyReadback: async () => true
  }), error => error.code === 'LIGHTSPEED_MUTATION_UNKNOWN' && error.mayHaveWritten === true);
  assert.equal(unknown, true);
  assert.equal(persisted, false);
});
