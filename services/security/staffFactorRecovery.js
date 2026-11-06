import { randomUUID } from 'node:crypto';

// Backend-only security administrator recovery. Never mounted as employee
// self-service, never authorize through PIN, TOTP or browser role headers.
const EMPLOYEE = /^[1-9][0-9]{0,17}$/;
const REASONS = new Set(['lost_device','suspected_compromise','employee_departed']);
const METHODS = new Set(['passkey','security-key','oidc-mfa']);
const denied = () => Object.assign(new Error('Strongly verified recovery approval required.'), {
  code:'HC_FACTOR_RECOVERY_DENIED',status:403
});
const unavailable = () => Object.assign(new Error('Factor recovery unavailable.'), {
  code:'HC_FACTOR_RECOVERY_UNAVAILABLE',status:503
});
export function createStaffFactorRecovery({
  pool, verifyStrongManager, canRecover, now = () => Date.now()
} = {}) {
  if (typeof pool?.connect !== 'function' || typeof verifyStrongManager !== 'function' ||
      typeof canRecover !== 'function' || typeof now !== 'function') {
    throw new TypeError('Trusted PostgreSQL and strong manager recovery authorization required.');
  }
  async function revoke({ context, employeeId, reason } = {}) {
    const target = String(employeeId || '');
    if (!EMPLOYEE.test(target) || !REASONS.has(reason)) throw denied();
    let manager;
    try {
      manager = await verifyStrongManager(context);
      const ts = now();
      if (manager?.active !== true || !EMPLOYEE.test(String(manager.id || '')) ||
          !METHODS.has(manager.method) ||
          !Number.isSafeInteger(ts) ||
          !Number.isSafeInteger(manager.authenticatedAtMs) ||
          manager.authenticatedAtMs > ts ||
          manager.authenticatedAtMs <= ts - 5 * 60_000) throw denied();
      if (await canRecover({
        context, approverId: String(manager.id), employeeId: target,
        operation:'staff.authenticator.recover', reason
      }) !== true) throw denied();
    } catch { throw denied(); }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const row = await client.query(
        `SELECT status FROM hc_staff_totp WHERE employee_id=$1 FOR UPDATE`,
        [target]);
      if (row.rowCount !== 1 || row.rows[0].status !== 'active') throw denied();
      // Ciphertext is wiped. Generation rotates so previously signed MFA
      // claims become invalid as soon as the transaction commits.
      await client.query(
        `UPDATE hc_staff_totp SET status='revoked',pending_expires_at=NULL,
         secret_ciphertext=decode('','hex'),factor_generation=gen_random_uuid(),
         last_used_step=-1,updated_at=now() WHERE employee_id=$1 AND status='active'`,
        [target]
      );
      const eventId = randomUUID();
      await client.query(
        `INSERT INTO hc_staff_factor_recovery_events
         (event_id,employee_id,approver_id,reason) VALUES ($1,$2,$3,$4)`,
        [eventId,target,String(manager.id),reason]
      );
      await client.query('COMMIT');
      return Object.freeze({revoked:true,eventId});
    } catch(error) {
      if(client) await client.query('ROLLBACK').catch(()=>{});
      if(error?.code==='HC_FACTOR_RECOVERY_DENIED') throw error;
      throw unavailable();
    } finally {client?.release()}
  }
  return Object.freeze({revoke});
}
