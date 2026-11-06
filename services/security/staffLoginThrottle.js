import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

// Future shared online login throttle, NOT mounted in production.
// A selected employee ID is a public *selector*, never proof of identity.
// Must reserve before PIN verification on EVERY exposed credential verifier.
// Requires db/hc_staff_auth_throttle.sql applied in an approved environment.
const DENIED_CONFIG = 'Staff login throttle must use persistent PostgreSQL storage and server-only secret.';
const UNAVAILABLE = () => Object.assign(new Error('Staff sign-in temporarily unavailable.'), {
  code: 'HC_LOGIN_THROTTLE_UNAVAILABLE', status: 503
});

export function createPostgresStaffLoginThrottle({
  pool, secret, scope = 'hc:staff:production',
  accountCapacity = 5, sourceCapacity = 15, refillSeconds = 900
} = {}) {
  if (typeof pool?.connect !== 'function' || typeof secret !== 'string' ||
      Buffer.byteLength(secret, 'utf8') < 32) throw new TypeError(DENIED_CONFIG);
  if (typeof scope !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{2,95}$/.test(scope) ||
      ![accountCapacity, sourceCapacity, refillSeconds].every(Number.isSafeInteger) ||
      accountCapacity < 1 || accountCapacity > 100 ||
      sourceCapacity < 1 || sourceCapacity > 1000 ||
      refillSeconds < 60 || refillSeconds > 86400) {
    throw new TypeError('Invalid trusted login throttle policy.');
  }
  const digest = value => createHmac('sha256', secret).update(value).digest('hex');

  async function reserve({ employeeId, sourceIp } = {}) {
    // Validate the selector *before* DB access. Never rely on a browser-provided
    // remote IP or X-Forwarded-For value: the router must supply verified req.ip
    // after configuring the exact trusted Railway/reverse-proxy hops.
    const employee = String(employeeId || '');
    if (!/^[1-9][0-9]{0,17}$/.test(employee) ||
        typeof sourceIp !== 'string' || isIP(sourceIp) === 0) {
      throw Object.assign(new Error('Valid login selector and server-observed source required.'), {
        code: 'HC_LOGIN_SELECTOR_REQUIRED', status: 400
      });
    }
    const buckets = [
      { hash: digest(scope + ':account:' + employee), capacity: accountCapacity },
      { hash: digest(scope + ':source:' + sourceIp), capacity: sourceCapacity }
    ].sort((a, b) => a.hash.localeCompare(b.hash));

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      let allowed = true;
      // Lexicographic ordering and FOR UPDATE prevent deadlocks and cross-replica
      // simultaneous oversubscription. A blocked bucket keeps its last refill
      // timestamp so repeated attacker attempts cannot extend lockout forever.
      for (const bucket of buckets) {
        await client.query(
          `INSERT INTO hc_staff_auth_throttle(key_hash,balance,updated_at)
           VALUES($1,$2,clock_timestamp()) ON CONFLICT (key_hash) DO NOTHING`,
          [bucket.hash, bucket.capacity]
        );
        const result = await client.query(
          `SELECT balance,updated_at,clock_timestamp() AS checked_at
           FROM hc_staff_auth_throttle WHERE key_hash=$1 FOR UPDATE`,
          [bucket.hash]
        );
        if (result.rowCount !== 1) throw new Error('Missing persisted login bucket.');
        const row = result.rows[0];
        const elapsed = Math.max(0, (new Date(row.checked_at) - new Date(row.updated_at)) / 1000);
        const balance = Math.min(bucket.capacity, Number(row.balance) +
          elapsed * bucket.capacity / refillSeconds);
        if (!Number.isFinite(balance)) throw new Error('Invalid login bucket state.');
        if (balance < 1) {
          allowed = false;
          continue;
        }
        await client.query(
          `UPDATE hc_staff_auth_throttle
           SET balance=$2,updated_at=$3 WHERE key_hash=$1`,
          [bucket.hash, balance - 1, row.checked_at]
        );
      }
      await client.query('COMMIT');
      return allowed;
    } catch {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw UNAVAILABLE(); // Fail closed; never reveal account/IP/bucket/server error.
    } finally {
      client?.release();
    }
  }
  return Object.freeze({ reserve });
}
