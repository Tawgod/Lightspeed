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
  await assert.rejects(policy.authorize({ ...input, writeEnabled: true }));
  const authorized = await policy.authorize({ ...input, writeEnabled: true, productionWriteApproved: true });
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
