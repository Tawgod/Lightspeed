import { createHmac, randomUUID } from 'node:crypto';

// A PIN-derived identity session can REQUEST enrollment but cannot APPROVE it.
// This service does NOT implement an IdP/manager passkey verifier. The hosting
// backend must supply independent strong-factor and exact-permission checks.
// Unmounted; do not install without that verifier and a tested release plan.
const EMPLOYEE = /^[1-9][0-9]{0,17}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METHODS = new Set(['passkey', 'security-key', 'oidc-mfa']);
const REQUEST_MS = 5 * 60_000;
const START_MS = 10 * 60_000;
const NOT_ALLOWED = () => Object.assign(new Error('Verified enrollment approval required.'), {
  status: 403, code: 'HC_FACTOR_APPROVAL_DENIED'
});
const UNAVAILABLE = () => Object.assign(new Error('Enrollment approvals unavailable.'), {
  status: 503, code: 'HC_FACTOR_APPROVAL_UNAVAILABLE'
});
const CONFLICT = () => Object.assign(new Error('Enrollment request already exists.'), {
  status: 409, code: 'HC_FACTOR_APPROVAL_CONFLICT'
});
function validEmployee(employee) {
  return employee?.active === true && EMPLOYEE.test(String(employee.id || ''));
}
export function createPostgresStaffEnrollmentApprovals({
  pool, secret, verifyEmployeeSession, getSessionBinding,
  verifyStrongApprover, canApprove, throttle, now = () => Date.now()
} = {}) {
  if (typeof pool?.connect !== 'function' || typeof secret !== 'string' ||
      Buffer.byteLength(secret) < 32 ||
      [verifyEmployeeSession, getSessionBinding, verifyStrongApprover, canApprove, now]
        .some(fn => typeof fn !== 'function') ||
      typeof throttle?.reserve !== 'function') {
    throw new TypeError('Durable store, session binding, strong approver and throttle required.');
  }
  const digest = binding => createHmac('sha256', secret)
    .update('hc:factor-approval:session:v1:' + binding).digest('hex');
  const stamp = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw UNAVAILABLE();
    return value;
  };
  async function identity(context) {
    try {
      const employee = await verifyEmployeeSession(context);
      if (!validEmployee(employee)) throw NOT_ALLOWED();
      const binding = await getSessionBinding(context, employee);
      // Must be derived from an authenticated, signed session (jti/digest),
      // never an Origin/header/employee-supplied field.
      if (typeof binding !== 'string' || !/^[A-Za-z0-9_.:-]{16,256}$/.test(binding)) throw NOT_ALLOWED();
      return { employeeId: String(employee.id), sessionHash: digest(binding) };
    } catch { throw NOT_ALLOWED(); }
  }
  async function tx(work) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505') throw CONFLICT();
      if (error?.code?.startsWith?.('HC_FACTOR_APPROVAL_')) throw error;
      throw UNAVAILABLE();
    } finally { client?.release(); }
  }
  function expiry(ms) { return new Date(ms).toISOString(); }

  async function request({ context, sourceIp } = {}) {
    const actor = await identity(context);
    let accepted = false;
    try { accepted = await throttle.reserve({ employeeId: actor.employeeId, sourceIp }) === true; }
    catch { throw UNAVAILABLE(); }
    if (!accepted) throw NOT_ALLOWED();
    const ts = stamp();
    const requestId = randomUUID();
    return tx(async client => {
      await client.query(
        `UPDATE hc_staff_factor_approvals SET state='expired'
         WHERE employee_id=$1 AND state IN ('requested','approved','started') AND expires_at<=$2`,
        [actor.employeeId, expiry(ts)]
      );
      await client.query(
        `INSERT INTO hc_staff_factor_approvals
         (request_id,employee_id,session_hash,state,expires_at)
         VALUES($1,$2,$3,'requested',$4)`,
        [requestId, actor.employeeId, actor.sessionHash, expiry(ts + REQUEST_MS)]
      );
      return Object.freeze({ requestId, state: 'requested', expiresAtMs: ts + REQUEST_MS });
    });
  }

  async function status({ context } = {}) {
    const actor = await identity(context);
    const ts = stamp();
    return tx(async client => {
      const result = await client.query(
        `SELECT request_id,state,expires_at FROM hc_staff_factor_approvals
         WHERE employee_id=$1 AND session_hash=$2 AND expires_at>$3
           AND state IN ('requested','approved','started')
         ORDER BY requested_at DESC LIMIT 1`,
        [actor.employeeId, actor.sessionHash, expiry(ts)]
      );
      const row = result.rows?.[0];
      return row ? Object.freeze({
        requestId: String(row.request_id), state: row.state,
        expiresAtMs: new Date(row.expires_at).getTime()
      }) : Object.freeze({ state: 'none' });
    });
  }

  // Only an independently authenticated manager/security administrator may
  // perform this. The manager proof MUST be passkey/security-key/verified OIDC
  // MFA, never PIN, TOTP, Origin or browser-supplied role claims.
  async function approve({ context, requestId } = {}) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw NOT_ALLOWED();
    let manager;
    try {
      manager = await verifyStrongApprover(context);
      const ts = stamp();
      if (!validEmployee(manager) ||
          !METHODS.has(manager.method) ||
          !Number.isSafeInteger(manager.authenticatedAtMs) ||
          manager.authenticatedAtMs > ts ||
          manager.authenticatedAtMs <= ts - 5 * 60_000) throw NOT_ALLOWED();
    } catch { throw NOT_ALLOWED(); }
    return tx(async client => {
      const result = await client.query(
        `SELECT employee_id,state,expires_at FROM hc_staff_factor_approvals
         WHERE request_id=$1 FOR UPDATE`, [requestId]
      );
      const row = result.rows?.[0];
      if (!row || row.state !== 'requested' || new Date(row.expires_at).getTime() <= stamp()) throw NOT_ALLOWED();
      let permission = false;
      try {
        permission = await canApprove({
          context, approverId: String(manager.id), employeeId: String(row.employee_id),
          operation: 'staff.authenticator.enroll'
        }) === true;
      } catch { /* deny */ }
      if (!permission) throw NOT_ALLOWED();
      const approvedAtMs = stamp();
      await client.query(
        `UPDATE hc_staff_factor_approvals SET state='approved',approver_id=$2,
         approver_method=$3,approved_at=$4 WHERE request_id=$1`,
        [requestId, String(manager.id), manager.method, expiry(approvedAtMs)]
      );
      return Object.freeze({ approved: true, requestId, employeeId: String(row.employee_id) });
    });
  }

  // Start may be called only after manager approval. A single approved
  // request can start ONE enrollment; QR regeneration needs a new approval.
  async function start({ context } = {}) {
    const actor = await identity(context);
    const ts = stamp();
    return tx(async client => {
      const result = await client.query(
        `UPDATE hc_staff_factor_approvals SET state='started',
         started_at=$3,expires_at=$4
         WHERE employee_id=$1 AND session_hash=$2 AND state='approved'
           AND expires_at>$3 RETURNING request_id`,
        [actor.employeeId, actor.sessionHash, expiry(ts), expiry(ts + START_MS)]
      );
      if (result.rowCount !== 1) throw NOT_ALLOWED();
      return true;
    });
  }

  async function allowConfirmation({ context } = {}) {
    const actor = await identity(context);
    const result = await tx(client => client.query(
      `SELECT request_id FROM hc_staff_factor_approvals
       WHERE employee_id=$1 AND session_hash=$2 AND state='started'
         AND expires_at>$3 LIMIT 1`,
      [actor.employeeId, actor.sessionHash, expiry(stamp())]
    ));
    return result.rowCount === 1;
  }

  async function finish({ context } = {}) {
    const actor = await identity(context);
    const result = await tx(client => client.query(
      `UPDATE hc_staff_factor_approvals SET state='finished',finished_at=$3
       WHERE employee_id=$1 AND session_hash=$2 AND state='started'
         AND expires_at>$3 RETURNING request_id`,
      [actor.employeeId, actor.sessionHash, expiry(stamp())]
    ));
    if (result.rowCount !== 1) throw NOT_ALLOWED();
    return true;
  }

  return Object.freeze({ request, status, approve, start, allowConfirmation, finish });
}
