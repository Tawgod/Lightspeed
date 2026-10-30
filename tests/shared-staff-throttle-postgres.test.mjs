import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { createPostgresStaffLoginThrottle } from '../services/security/staffLoginThrottle.js';

const uri = process.env.HC_TEST_DATABASE_URL;
const gated = { skip: uri ? false : 'Only run against disposable HC_TEST_DATABASE_URL.' };
const secret = 'dedicated-test-only-staff-login-throttle-key-123456789';
const digest = value => createHmac('sha256', secret).update(value).digest('hex');

test('staff limiter configuration and caller selectors fail closed', async () => {
  assert.throws(() => createPostgresStaffLoginThrottle(), TypeError);
  const mock = { connect: async () => { throw Error('database down'); } };
  const guard = createPostgresStaffLoginThrottle({ pool: mock, secret });
  await assert.rejects(guard.reserve({ employeeId: '1', sourceIp: '203.0.113.1' }),
    error => error.code === 'HC_LOGIN_THROTTLE_UNAVAILABLE' &&
      !error.message.includes('database down'));
  await assert.rejects(guard.reserve({ employeeId: 'Alice', sourceIp: '203.0.113.1' }),
    error => error.code === 'HC_LOGIN_SELECTOR_REQUIRED');
  await assert.rejects(guard.reserve({ employeeId: '1', sourceIp: 'Forged-Forwarded-For' }),
    error => error.code === 'HC_LOGIN_SELECTOR_REQUIRED');
});

test('Postgres throttle: independent account/source ceilings, concurrency and safe recovery', gated, async () => {
  if (!/hc_test/.test(uri)) throw Error('Refusing to connect to any non-test database.');
  const pool = new pg.Pool({ connectionString: uri, max: 15 });
  try {
    await pool.query(await fs.readFile(new URL('../db/hc_staff_auth_throttle.sql', import.meta.url), 'utf8'));
    const scope = 'hc:staff:unit';
    const guardA = createPostgresStaffLoginThrottle({ pool, secret, scope,
      accountCapacity: 5, sourceCapacity: 15 });
    const guardB = createPostgresStaffLoginThrottle({ pool, secret, scope,
      accountCapacity: 5, sourceCapacity: 15 });

    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? guardB : guardA).reserve({ employeeId: '17',
        sourceIp: '203.0.113.101' })));
    assert.equal(concurrent.filter(Boolean).length, 5);
    assert.equal(concurrent.filter(x => !x).length, 3);
    // Switching sources cannot increase the employee's allowed guessing budget.
    assert.equal(await guardA.reserve({ employeeId: '17', sourceIp: '198.51.100.33' }), false);

    // Different accounts share the source budget (not independent pairs).
    const oneSource = await Promise.all(Array.from({ length: 17 }, (_, i) =>
      guardB.reserve({ employeeId: String(i + 100), sourceIp: '203.0.113.55' })));
    assert.equal(oneSource.filter(Boolean).length, 15);
    assert.equal(oneSource.filter(x => !x).length, 2);

    const accountHash = digest(scope + ':account:17');
    const before = await pool.query('SELECT balance,updated_at FROM hc_staff_auth_throttle WHERE key_hash=$1', [accountHash]);
    assert.equal(before.rowCount, 1);
    assert.equal(Number(before.rows[0].balance) < 1, true);
    await guardA.reserve({ employeeId: '17', sourceIp: '198.51.100.34' });
    const after = await pool.query('SELECT updated_at FROM hc_staff_auth_throttle WHERE key_hash=$1', [accountHash]);
    assert.equal(new Date(after.rows[0].updated_at).getTime(), new Date(before.rows[0].updated_at).getTime(),
      'rejected attempt must not extend the blocked account bucket');

    // Advance only disposable-test clock state. Real login recovery is elapsed refill.
    await pool.query(`UPDATE hc_staff_auth_throttle
      SET balance=0,updated_at=now()-interval '20 minutes' WHERE key_hash=$1`, [accountHash]);
    assert.equal(await guardA.reserve({ employeeId: '17', sourceIp: '198.51.100.99' }), true);

    const saved = await pool.query('SELECT key_hash FROM hc_staff_auth_throttle WHERE key_hash=$1', [accountHash]);
    assert.equal(saved.rows[0].key_hash.trim(), accountHash);
    assert.equal(saved.rows[0].key_hash.includes('17'), false);
    const sensitiveColumns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='hc_staff_auth_throttle'`);
    assert.deepEqual(sensitiveColumns.rows.map(x => x.column_name).sort(),
      ['balance','key_hash','updated_at']);
  } finally {
    await pool.end();
  }
});
