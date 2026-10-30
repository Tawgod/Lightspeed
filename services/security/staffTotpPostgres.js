import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createStaffTotpProvisioningUri, generateStaffTotpSecret, matchStaffTotpStep } from './staffTotp.js';

// Unmounted backend-only candidate. No routes, no reset API, no logging codes.
// Caller supplies Timeclock-backed signed-session verification and separately
// approved enrollment, plus durable per-account/per-source login throttling.
const invalid = () => Object.assign(new Error('Authenticator verification failed.'), {
  code: 'HC_TOTP_INVALID', status: 401
});
const unavailable = () => Object.assign(new Error('Authenticator service unavailable.'), {
  code: 'HC_TOTP_UNAVAILABLE', status: 503
});
const denied = () => Object.assign(new Error('Authenticator enrollment not permitted.'), {
  code: 'HC_TOTP_ENROLLMENT_DENIED', status: 403
});
const TEN_MINUTES = 10 * 60 * 1000;

function checkKey(key) {
  const bytes = Buffer.isBuffer(key) ? Buffer.from(key) :
    (typeof key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(key) ? Buffer.from(key, 'base64') : null);
  if (!bytes || bytes.length !== 32) throw new TypeError('A separate 32-byte TOTP encryption key is required.');
  return bytes;
}
function encrypt(secret, key, employeeId) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('hc:staff:totp:' + employeeId));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}
function decrypt(bytes, key, employeeId) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 29) throw new Error('Malformed stored factor.');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  decipher.setAAD(Buffer.from('hc:staff:totp:' + employeeId));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

export function createPostgresStaffTotp({
  pool, encryptionKey, verifyEmployeeSession, authorizeEnrollment,
  loginThrottle, issuer = 'Hobby Corner', now = () => Date.now()
} = {}) {
  if (typeof pool?.connect !== 'function' ||
      typeof verifyEmployeeSession !== 'function' ||
      typeof authorizeEnrollment !== 'function' ||
      typeof loginThrottle?.reserve !== 'function' || typeof now !== 'function') {
    throw new TypeError('Trusted staff session, enrollment, throttle and PostgreSQL adapters required.');
  }
  const key = checkKey(encryptionKey);

  async function employeeFromContext(context) {
    try {
      const employee = await verifyEmployeeSession(context);
      if (!employee || employee.active !== true ||
          !/^[1-9][0-9]{0,17}$/.test(String(employee.id))) throw denied();
      return String(employee.id);
    } catch { throw denied(); }
  }
  async function permittedEnrollment(context, employeeId, phase) {
    try {
      if (await authorizeEnrollment({ context, employeeId, phase }) === true) return;
    } catch { /* denied */ }
    throw denied();
  }
  async function inTransaction(work) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error?.code?.startsWith?.('HC_TOTP_')) throw error;
      throw unavailable();
    } finally { client?.release(); }
  }

  // Safe method metadata only. Never expose the seed, encrypted bytes,
  // last used code step, or enrollment failure count to the client.
  async function status({ context } = {}) {
    const employeeId = await employeeFromContext(context);
    return inTransaction(async client => {
      const result = await client.query(
        `SELECT status,pending_expires_at FROM hc_staff_totp
         WHERE employee_id=$1`, [employeeId]);
      const row = result.rows?.[0];
      if (!row) return Object.freeze({ state: 'not_enrolled' });
      if (row.status === 'active') return Object.freeze({ state: 'active' });
      if (row.status === 'pending' &&
          new Date(row.pending_expires_at).getTime() > now()) {
        return Object.freeze({ state: 'pending', expiresAtMs:
          new Date(row.pending_expires_at).getTime() });
      }
      return Object.freeze({ state: 'not_enrolled' });
    });
  }

  async function getActiveGeneration({ context } = {}) {
    const employeeId = await employeeFromContext(context);
    return inTransaction(async client => {
      const result = await client.query(
        `SELECT factor_generation FROM hc_staff_totp
         WHERE employee_id=$1 AND status='active'`, [employeeId]);
      const generation = result.rows?.[0]?.factor_generation;
      return typeof generation === 'string' ? generation : null;
    });
  }

  async function beginEnrollment({ context } = {}) {
    const employeeId = await employeeFromContext(context);
    await permittedEnrollment(context, employeeId, 'begin');
    const secret = generateStaffTotpSecret();
    const encrypted = encrypt(secret, key, employeeId);
    const expiresAtMs = now() + TEN_MINUTES;
    if (!Number.isSafeInteger(expiresAtMs)) throw unavailable();
    await inTransaction(async client => {
      const result = await client.query(
        `INSERT INTO hc_staff_totp(employee_id,secret_ciphertext,status,pending_expires_at)
         VALUES($1,$2,'pending',$3::timestamptz)
         ON CONFLICT(employee_id) DO UPDATE
         SET secret_ciphertext=EXCLUDED.secret_ciphertext,
             status='pending',pending_expires_at=EXCLUDED.pending_expires_at,
             enrollment_failures=0,last_used_step=-1,
             factor_generation=gen_random_uuid(),updated_at=now()
         WHERE hc_staff_totp.status IN ('pending','revoked')
         RETURNING employee_id`,
        [employeeId, encrypted, new Date(expiresAtMs).toISOString()]
      );
      // Never replace a confirmed factor through the regular enrollment flow.
      if (result.rowCount !== 1) throw denied();
    });
    return Object.freeze({
      provisioningUri: createStaffTotpProvisioningUri({ secret, employeeId, issuer }),
      expiresAtMs
    });
  }

  async function confirmEnrollment({ context, code } = {}) {
    const employeeId = await employeeFromContext(context);
    await permittedEnrollment(context, employeeId, 'confirm');
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw invalid();
    return inTransaction(async client => {
      const result = await client.query(
        `SELECT secret_ciphertext,status,pending_expires_at,enrollment_failures
         FROM hc_staff_totp WHERE employee_id=$1 FOR UPDATE`, [employeeId]);
      const row = result.rows?.[0];
      if (!row || row.status !== 'pending' ||
          new Date(row.pending_expires_at).getTime() <= now() ||
          Number(row.enrollment_failures) >= 5) throw invalid();
      const secret = decrypt(row.secret_ciphertext, key, employeeId);
      const step = matchStaffTotpStep({ secret, code, nowMs: now() });
      if (step === null) {
        await client.query(
          `UPDATE hc_staff_totp SET enrollment_failures=enrollment_failures+1,
           updated_at=now() WHERE employee_id=$1`, [employeeId]);
        // Commit the failed attempt; don't rollback the counter.
        return { confirmed: false };
      }
      await client.query(
        `UPDATE hc_staff_totp SET status='active',pending_expires_at=NULL,
         last_used_step=$2,enrollment_failures=0,updated_at=now()
         WHERE employee_id=$1`, [employeeId, step]);
      return { confirmed: true };
    }).then(async result => {
      if (!result.confirmed) throw invalid();
      // For a durable one-time manager grant, mark it finished AFTER the
      // authenticator becomes active. A failure is not permission to retry
      // the enrollment; staff can inspect active status to recover.
      await permittedEnrollment(context, employeeId, 'finish');
      return Object.freeze({ confirmed: true });
    });
  }

  async function verifyCode({ context, code, sourceIp } = {}) {
    const employeeId = await employeeFromContext(context);
    // This must be called BEFORE any code comparison, including malformed
    // codes, and on every verification attempt; it is distinct from PIN limits.
    let admitted;
    try { admitted = await loginThrottle.reserve({ employeeId, sourceIp }); }
    catch { throw unavailable(); }
    if (admitted !== true) throw invalid();
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw invalid();

    return inTransaction(async client => {
      const result = await client.query(
        `SELECT secret_ciphertext,last_used_step,status
         FROM hc_staff_totp WHERE employee_id=$1 FOR UPDATE`, [employeeId]);
      const row = result.rows?.[0];
      if (!row || row.status !== 'active') throw invalid();
      const secret = decrypt(row.secret_ciphertext, key, employeeId);
      const step = matchStaffTotpStep({ secret, code, nowMs: now() });
      if (step === null || step <= Number(row.last_used_step)) throw invalid();
      const saved = await client.query(
        `UPDATE hc_staff_totp SET last_used_step=$2,updated_at=now()
         WHERE employee_id=$1 AND last_used_step<$2 RETURNING employee_id`,
        [employeeId, step]);
      if (saved.rowCount !== 1) throw invalid();
      // A proof may ONLY become an access claim via a SERVER-SIGNED,
      // employee/session-bound short-lived session issued by the caller.
      // Never send this plain object to browsers as an authorization token.
      return Object.freeze({
        verified: true, employeeId, method: 'totp', authenticatedAtMs: now()
      });
    });
  }
  return Object.freeze({ status, getActiveGeneration, beginEnrollment, confirmEnrollment, verifyCode });
}
