import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPostgresStaffTotp } from '../services/security/staffTotpPostgres.js';

const uri = process.env.HC_TEST_DATABASE_URL;
const guarded = { skip: !uri ? 'Disposable hc_test database required.' : false };
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function decodeBase32(s) {
  let b = 0, v = 0;
  const result = [];
  for (const ch of s) {
    v = v * 32 + alphabet.indexOf(ch); b += 5;
    if (b >= 8) {
      b -= 8;
      result.push(Math.floor(v / (2 ** b)) & 255);
      v %= 2 ** b;
    }
  }
  return Buffer.from(result);
}
// Test-only independent RFC 4226 generator, never included in application code.
function token(secret, nowMs) {
  const key = decodeBase32(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  return String((mac.readUInt32BE(mac.at(-1) & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}

test('encrypted TOTP enrollment, one-time verification and failure handling across PG clients', guarded, async () => {
  if (!/hc_test/.test(uri)) throw Error('Refusing non-disposable database.');
  const pool = new pg.Pool({ connectionString: uri, max: 10 });
  let clock = Date.parse('2026-10-30T18:00:00Z');
  const key = randomBytes(32);
  let throttleCalls = 0;
  const auth = {
    pool, encryptionKey: key, now: () => clock,
    verifyEmployeeSession: async context => context?.session === 'valid'
      ? { id: context.employeeId || 17, active: true } : null,
    authorizeEnrollment: async ({context}) => context?.approval === 'verified-manager-approval',
    loginThrottle: { reserve: async ({employeeId,sourceIp}) => {
      throttleCalls++;
      return employeeId === '17' && sourceIp === '203.0.113.11';
    }}
  };
  const approved = {session:'valid',approval:'verified-manager-approval'};
  const session = {session:'valid'};
  try {
    await pool.query(await fs.readFile(new URL('../db/hc_staff_totp.sql', import.meta.url), 'utf8'));
    const first = createPostgresStaffTotp(auth);
    const second = createPostgresStaffTotp(auth);

    await assert.rejects(first.beginEnrollment({context:session}),
      e => e.code === 'HC_TOTP_ENROLLMENT_DENIED');
    const enrollment = await first.beginEnrollment({context:approved});
    const parsed = new URL(enrollment.provisioningUri);
    const secret = parsed.searchParams.get('secret');
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(enrollment.expiresAtMs, clock + 600000);
    const row = await pool.query('SELECT secret_ciphertext,status FROM hc_staff_totp WHERE employee_id=17');
    assert.equal(row.rows[0].status, 'pending');
    assert.equal(row.rows[0].secret_ciphertext.includes(Buffer.from(secret)), false);
    await assert.rejects(second.confirmEnrollment({context:approved,code:'not-code'}),
      e => e.code === 'HC_TOTP_INVALID');
    const invalidCode = token(secret,clock) === '000000' ? '999999' : '000000';
    await assert.rejects(second.confirmEnrollment({context:approved,code:invalidCode}),
      e => e.code === 'HC_TOTP_INVALID');
    const failures = await pool.query('SELECT enrollment_failures FROM hc_staff_totp WHERE employee_id=17');
    assert.equal(Number(failures.rows[0].enrollment_failures), 1);
    assert.deepEqual(await second.confirmEnrollment({context:approved,code:token(secret,clock)}),
      {confirmed:true});
    await assert.rejects(first.beginEnrollment({context:approved}),
      e => e.code === 'HC_TOTP_ENROLLMENT_DENIED');

    // Enrollment consumes the step so the same QR confirmation code can't
    // grant a second factor immediately.
    await assert.rejects(first.verifyCode({context:session,code:token(secret,clock),sourceIp:'203.0.113.11'}),
      e => e.code === 'HC_TOTP_INVALID');
    clock += 30000;
    const code = token(secret,clock);
    const outcomes = await Promise.allSettled([
      first.verifyCode({context:session,code,sourceIp:'203.0.113.11'}),
      second.verifyCode({context:session,code,sourceIp:'203.0.113.11'})
    ]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    const proof = outcomes.find(x=>x.status==='fulfilled').value;
    assert.deepEqual(proof, {
      verified:true,employeeId:'17',method:'totp',authenticatedAtMs:clock
    });
    await assert.rejects(first.verifyCode({context:session,code,sourceIp:'203.0.113.11'}),
      e => e.code === 'HC_TOTP_INVALID');
    assert.ok(throttleCalls >= 4);
    await assert.rejects(first.verifyCode({context:{session:'invalid'},code,sourceIp:'203.0.113.11'}),
      e => e.code === 'HC_TOTP_ENROLLMENT_DENIED');
    await assert.rejects(first.verifyCode({context:session,code,sourceIp:'198.51.100.1'}),
      e => e.code === 'HC_TOTP_INVALID');

    const saved = await pool.query('SELECT status,last_used_step FROM hc_staff_totp WHERE employee_id=17');
    assert.equal(saved.rows[0].status,'active');
    assert.ok(Number(saved.rows[0].last_used_step)>0);
  } finally {
    await pool.end();
  }
});

test('production TOTP adapters require encryption, enrollment authorization and throttling', () => {
  assert.throws(() => createPostgresStaffTotp(), TypeError);
  assert.throws(() => createPostgresStaffTotp({
    pool:{connect(){}},verifyEmployeeSession() {},authorizeEnrollment() {},
    loginThrottle:{reserve() {}},encryptionKey:Buffer.alloc(10)
  }), TypeError);
});
