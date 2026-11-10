// Dedicated server-to-server Owner staging identity boundary.
// Never reuse the Scanner credential, trust browser role/employee claims, or
// allow this router to create a Timeclock/Owner account.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';

const isId = value => /^[1-9][0-9]{0,17}$/.test(String(value ?? '')) &&
  Number.isSafeInteger(Number(value)) && String(value) !== '901';
const fixedSecret = value => typeof value === 'string' && Buffer.byteLength(value) >= 32;
const deny = (res, status = 403) => res.status(status).json({ error: 'Employee verification denied.' });

// Use a database-backed atomic counter, shared across Railway replicas. This
// source is the actual socket peer, NOT user-controlled X-Forwarded-For.
export function createOwnerStageLimiter({ pool, secret, windowMs = 15 * 60_000 } = {}) {
  if (!pool?.connect || !fixedSecret(secret)) throw new Error('Durable throttle unavailable.');
  return async function reserve({ employeeId, sourceIp, action }) {
    if (!isId(employeeId) || typeof sourceIp !== 'string' || !sourceIp ||
        !['pin', 'authorize'].includes(action)) throw new Error('Invalid throttle scope.');
    const scope = action === 'pin' ? 'pin' : 'authorize';
    const max = scope === 'pin' ? 5 : 120;
    const key = createHmac('sha256', secret)
      .update('owner-stage:' + scope + ':' + String(employeeId)).digest('hex');
    // Account-global limiter; deliberately no spoofable client-IP override.
    // Source IP can be audited after proxy-origin validation is reviewed.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO hc_owner_stage_login_limits(scope_key, count, window_start)
         VALUES($1, 1, now())
         ON CONFLICT(scope_key) DO UPDATE SET
           count = CASE WHEN hc_owner_stage_login_limits.window_start <
                         now() - ($2::bigint * interval '1 millisecond')
                        THEN 1 ELSE hc_owner_stage_login_limits.count + 1 END,
           window_start = CASE WHEN hc_owner_stage_login_limits.window_start <
                         now() - ($2::bigint * interval '1 millisecond')
                         THEN now() ELSE hc_owner_stage_login_limits.window_start END
         RETURNING count`,
        [key, windowMs]
      );
      if (result.rowCount !== 1) throw new Error('Throttle unavailable.');
      await client.query('COMMIT');
      return result.rows[0].count <= max;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };
}

export function createOwnerStageIdentityRouter({
  pool, pinHash, permissions, environment = process.env, reserve
} = {}) {
  if (!pool?.query || typeof pinHash !== 'function' ||
      typeof permissions !== 'function') throw new TypeError('Timeclock adapters required.');
  const enabled = environment.OWNER_STAGING_IDENTITY_ENABLED === 'true';
  const id = String(environment.OWNER_STAGING_EMPLOYEE_ID ?? '');
  const secret = environment.OWNER_STAGING_SERVICE_SECRET;
  const scannerSecret = environment.SCANNER_SERVICE_SECRET;
  const configured = enabled && isId(id) && fixedSecret(secret) &&
    fixedSecret(environment.OWNER_STAGING_THROTTLE_SECRET) &&
    secret !== scannerSecret;
  const limiter = reserve || (configured ?
    createOwnerStageLimiter({pool, secret: environment.OWNER_STAGING_THROTTLE_SECRET}) : null);
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!configured || req.get('origin') || req.get('sec-fetch-site')) return deny(res);
    const supplied = req.get('x-owner-staging-service-secret') || '';
    const a = Buffer.from(supplied), b = Buffer.from(secret || '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return deny(res);
    next();
  });
  router.post('/verify-pin', async (req, res) => {
    const pin = req.body?.pin;
    if (typeof pin !== 'string' || !/^\\d{4}$/.test(pin)) return deny(res, 401);
    try {
      if (!await limiter({employeeId:id,sourceIp:req.socket.remoteAddress,action:'pin'}))
        return deny(res, 429);
      const rows = await pool.query(
        'SELECT id,name,active FROM employees WHERE id=$1 AND pin_hash=$2 AND active=TRUE LIMIT 1',
        [id, pinHash(pin)]
      );
      if (rows.rowCount !== 1 || String(rows.rows[0]?.id) !== id) return deny(res, 401);
      return res.json({employee: await permissions(rows.rows[0])});
    } catch { return deny(res, 503); }
  });
  router.post('/authorize', async (req, res) => {
    if (String(req.body?.employeeId ?? '') !== id) return deny(res);
    try {
      if (!await limiter({employeeId:id,sourceIp:req.socket.remoteAddress,action:'authorize'}))
        return deny(res, 429);
      const rows = await pool.query('SELECT id,name,active FROM employees WHERE id=$1 AND active=TRUE LIMIT 1', [id]);
      if (rows.rowCount !== 1 || String(rows.rows[0]?.id) !== id) return deny(res);
      return res.json({employee: await permissions(rows.rows[0])});
    } catch { return deny(res, 503); }
  });
  return router;
}
