import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import { createPostgresLightspeedAuditAppend, createPostgresLightspeedIdempotencyStore } from '../services/lightspeed/postgres.js';
import { createLightspeedIdempotency } from '../services/lightspeed/idempotency.js';
import { createLightspeedAudit } from '../services/lightspeed/audit.js';

const uri = process.env.HC_TEST_DATABASE_URL;
const gated = { skip: !uri ? 'HC_TEST_DATABASE_URL not provided; only run against a disposable test database' : false };

test('real PostgreSQL: concurrency, verified replay, unknown write, immutable audit', gated, async () => {
  // CI supplies a dedicated empty PostgreSQL container, never production.
  if (!/hc_test/.test(uri)) throw new Error('Refusing database integration tests without explicitly named hc_test database.');
  const pool = new pg.Pool({ connectionString: uri, max: 8 });
  try {
    await pool.query(await fs.readFile(new URL('../db/lightspeed_shared_foundation.sql', import.meta.url), 'utf8'));
    const storeA = createPostgresLightspeedIdempotencyStore({ pool });
    const storeB = createPostgresLightspeedIdempotencyStore({ pool });
    const key = 'integration-concurrent-001';
    const scope = 'test:shop:products.create';
    const fingerprint = 'a'.repeat(64);
    const attempts = await Promise.all([
      storeA.claim({ scope, key, fingerprint }),
      storeB.claim({ scope, key, fingerprint })
    ]);
    assert.equal(attempts.filter(x => x.state === 'claimed').length, 1);
    assert.equal(attempts.filter(x => x.state === 'unknown').length, 1);
    const lease = attempts.find(x => x.state === 'claimed').lease;
    const result = { id: 'P001', status: 'verified' };
    await storeA.complete({ scope, key, fingerprint, lease, result, verified: true });
    assert.deepEqual(await storeB.claim({ scope, key, fingerprint }),
      { state: 'replay', verified: true, fingerprint, result });
    assert.deepEqual(await storeA.claim({ scope, key, fingerprint: 'b'.repeat(64) }),
      { state: 'conflict' });
    await assert.rejects(storeA.complete({ scope, key, fingerprint, lease, result, verified: true }),
      e => e.code === 'LIGHTSPEED_PERSISTENCE_UNAVAILABLE');
    await assert.rejects(storeA.markUnknown({ scope, key, fingerprint, lease }),
      e => e.code === 'LIGHTSPEED_RECONCILE_REQUIRED');
    assert.equal((await storeA.claim({ scope, key, fingerprint })).state, 'replay');

    const failedKey = 'integration-unknown-002';
    const claimed = await storeA.claim({ scope, key: failedKey, fingerprint });
    assert.equal(claimed.state, 'claimed');
    await storeB.markUnknown({ scope, key: failedKey, fingerprint, lease: claimed.lease });
    assert.equal((await storeA.claim({ scope, key: failedKey, fingerprint })).state, 'unknown');

    const audit = createLightspeedAudit({ append: createPostgresLightspeedAuditAppend({ pool }) });
    const meta = { stage: 'requested', correlationId: 'test-integration-001',
      operation: 'products.create', actorType: 'service', actorId: 'integration-test',
      entityType: 'product', entityId: null, fingerprint };
    const receipt = await audit.record(meta);
    assert.match(receipt.eventId, /^\d+$/);
    await assert.rejects(pool.query(
      'UPDATE hc_lightspeed_audit SET outcome=$1 WHERE event_id=$2',
      ['tamper', receipt.eventId]
    ), /append-only/);
    await assert.rejects(pool.query(
      'DELETE FROM hc_lightspeed_audit WHERE event_id=$1',
      [receipt.eventId]
    ), /append-only/);

    const actual = createLightspeedIdempotency({ store: storeA });
    let attempted = 0;
    const input = { key: 'integration-gated-003', scope, payload: { sku: '000100' },
      execute: async () => { attempted++; return { id: 'P100' }; },
      verifyReadback: async value => value.id === 'P100' };
    await actual.run(input);
    const replay = await actual.run(input);
    assert.equal(replay.replayed, true);
    assert.equal(attempted, 1);
  } finally {
    await pool.end();
  }
});
