import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import { createPostgresStaffEnrollmentApprovals } from '../services/security/staffEnrollmentApprovals.js';

const uri = process.env.HC_TEST_DATABASE_URL;
const guarded = { skip: !uri ? 'Disposable hc_test PostgreSQL required' : false };
test('enrollment approvals require independent signed manager proof and session binding', guarded, async () => {
  if (!/hc_test/.test(uri)) throw Error('Refusing non-test database.');
  const pool = new pg.Pool({ connectionString: uri });
  let clock = Date.parse('2026-10-30T21:00:00Z');
  let signedManager = false;
  let managerGranted = true;
  const options = {
    pool, secret: 'test-only-approval-session-hmac-key-123456789012345',
    now: () => clock,
    verifyEmployeeSession: async ctx => ctx?.base === 'valid'
      ? { id: ctx.employeeId || 17, active: true } : null,
    getSessionBinding: async ctx => ctx.sessionBinding,
    verifyStrongApprover: async () => signedManager ? {
      id: 8, active: true, method: 'passkey', authenticatedAtMs: clock - 1000
    } : { id: 8, active: true, method: 'pin', authenticatedAtMs: clock },
    canApprove: async ({ approverId, employeeId, operation }) =>
      managerGranted && approverId === '8' && employeeId === '17' &&
      operation === 'staff.authenticator.enroll',
    throttle: { reserve: async ({ employeeId, sourceIp }) =>
      employeeId === '17' && sourceIp === '203.0.113.11' }
  };
  const employee = { base: 'valid', sessionBinding: 'signed-session-jti-employee-17' };
  const impostor = { base: 'valid', sessionBinding: 'another-signed-session-identity', employeeId: 17 };
  try {
    await pool.query(await fs.readFile(new URL('../db/hc_staff_factor_approvals.sql', import.meta.url), 'utf8'));
    const a = createPostgresStaffEnrollmentApprovals(options);
    const b = createPostgresStaffEnrollmentApprovals(options);

    await assert.rejects(a.request({ context: { base: 'invalid', sessionBinding: employee.sessionBinding },
      sourceIp: '203.0.113.11' }), e => e.code === 'HC_FACTOR_APPROVAL_DENIED');
    await assert.rejects(a.request({ context: employee, sourceIp: 'untrusted-forwarded' }),
      e => e.code === 'HC_FACTOR_APPROVAL_UNAVAILABLE');

    const requested = await a.request({ context: employee, sourceIp: '203.0.113.11' });
    assert.match(requested.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(requested.state, 'requested');
    assert.deepEqual(await b.status({ context: impostor }), {state:'none'});
    assert.equal((await b.status({ context: employee })).state, 'requested');
    await assert.rejects(b.request({ context: employee, sourceIp: '203.0.113.11' }),
      e => e.code === 'HC_FACTOR_APPROVAL_CONFLICT');

    await assert.rejects(b.approve({ context: {}, requestId: requested.requestId }),
      e => e.code === 'HC_FACTOR_APPROVAL_DENIED');
    signedManager = true; managerGranted = false;
    await assert.rejects(b.approve({ context: {}, requestId: requested.requestId }),
      e => e.code === 'HC_FACTOR_APPROVAL_DENIED');
    managerGranted = true;
    await assert.rejects(a.start({ context: employee }),
      e => e.code === 'HC_FACTOR_APPROVAL_DENIED');
    assert.equal((await b.approve({ context: {}, requestId: requested.requestId })).approved, true);
    await assert.rejects(b.approve({ context: {}, requestId: requested.requestId }),
      e => e.code === 'HC_FACTOR_APPROVAL_DENIED');
    assert.equal((await b.status({ context: employee })).state, 'approved');
    await assert.rejects(b.start({ context: impostor }),
      e => e.code === 'HC_FACTOR_APPROVAL_DENIED');
    const concurrent = await Promise.allSettled([
      a.start({ context: employee }), b.start({ context: employee })
    ]);
    assert.equal(concurrent.filter(x=>x.status==='fulfilled').length, 1);
    assert.equal(concurrent.filter(x=>x.status==='rejected').length, 1);
    assert.equal(await a.allowConfirmation({ context: employee }), true);
    assert.equal(await a.allowConfirmation({ context: impostor }), false);
    const row = await pool.query(
      'SELECT session_hash,state,approver_id,approver_method FROM hc_staff_factor_approvals WHERE request_id=$1',
      [requested.requestId]);
    assert.equal(row.rows[0].state, 'started');
    assert.equal(row.rows[0].approver_id, '8');
    assert.equal(row.rows[0].approver_method, 'passkey');
    assert.match(row.rows[0].session_hash, /^[a-f0-9]{64}$/);
    assert.ok(!row.rows[0].session_hash.includes(employee.sessionBinding));
    assert.equal(await a.finish({ context: employee }), true);
    await assert.rejects(a.finish({ context: employee }),
      e => e.code === 'HC_FACTOR_APPROVAL_DENIED');
    assert.deepEqual(await b.status({ context: employee }), { state: 'none' });
  } finally { await pool.end(); }
});
test('expired approval cannot be approved, consumed or attached to a new PIN session', guarded, async () => {
  if (!/hc_test/.test(uri)) throw Error('Refusing non-test database.');
  const pool = new pg.Pool({ connectionString: uri });
  let clock = Date.parse('2026-10-30T22:00:00Z');
  const auth = createPostgresStaffEnrollmentApprovals({
    pool, secret: 'test-only-approval-session-hmac-key-123456789012345',
    now: () => clock,
    verifyEmployeeSession: async () => ({id:27, active:true}),
    getSessionBinding: async ctx => ctx.binding,
    verifyStrongApprover: async () => ({
      id:8, active:true, method:'passkey', authenticatedAtMs:clock - 1000
    }),
    canApprove: async () => true,
    throttle: { reserve: async () => true }
  });
  const employee = {binding:'signed-employee-27-jti'};
  try {
    await pool.query(await fs.readFile(new URL('../db/hc_staff_factor_approvals.sql', import.meta.url), 'utf8'));
    const request = await auth.request({ context: employee, sourceIp: '203.0.113.7' });
    clock += 5 * 60_000 + 1;
    await assert.rejects(auth.approve({context:{},requestId:request.requestId}),
      e => e.code === 'HC_FACTOR_APPROVAL_DENIED');
    assert.deepEqual(await auth.status({context:employee}),{state:'none'});
    assert.equal((await auth.request({context:employee,sourceIp:'203.0.113.7'})).state,'requested');
  } finally { await pool.end(); }
});
