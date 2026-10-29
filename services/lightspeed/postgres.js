import { randomUUID } from 'node:crypto';

// Durable Postgres adapters, operating through an existing server-side pg Pool.
// Schema is db/lightspeed_shared_foundation.sql; this module does not migrate DB on import.
// Do not use a transient memory store in multi-replica Railway deployments.
const requirePool = pool => {
  if (typeof pool?.query !== 'function') throw new TypeError('PostgreSQL pool required.');
};
const checkedRow = (result, label) => {
  if (result?.rowCount !== 1 || !result.rows?.[0]) {
    throw Object.assign(new Error(label + ' could not be persisted.'), { code: 'LIGHTSPEED_PERSISTENCE_UNAVAILABLE' });
  }
  return result.rows[0];
};

export function createPostgresLightspeedAuditAppend({ pool } = {}) {
  requirePool(pool);
  return async function append(event) {
    const result = await pool.query(
      `INSERT INTO hc_lightspeed_audit
       (occurred_at,stage,correlation_id,operation,actor_type,actor_id,entity_type,entity_id,fingerprint,outcome)
       VALUES ($1::timestamptz,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING event_id`,
      [event.timestamp,event.stage,event.correlationId,event.operation,event.actorType,event.actorId,
       event.entityType,event.entityId,event.fingerprint,event.outcome]
    );
    return { id: String(checkedRow(result, 'Audit event').event_id) };
  };
}

export function createPostgresLightspeedIdempotencyStore({ pool } = {}) {
  requirePool(pool);
  return Object.freeze({
    // Read-only operator reconciliation metadata. No lease, raw request, or stored
    // vendor response is returned; never mount this method as a public endpoint.
    async inspect({ scope, key }) {
      if (typeof scope !== 'string' || !/^[a-z][a-z0-9_.:-]{2,190}$/.test(scope) ||
          typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{8,150}$/.test(key)) {
        throw new TypeError('Valid idempotency scope and key required.');
      }
      const found = await pool.query(
        `SELECT fingerprint,state,created_at,updated_at,verified_at
         FROM hc_lightspeed_idempotency WHERE scope=$1 AND operation_key=$2`,
        [scope, key]
      );
      if (found?.rowCount === 0) return null;
      const row = checkedRow(found, 'Mutation inspection');
      return Object.freeze({
        fingerprint: row.fingerprint,
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        verifiedAt: row.verified_at
      });
    },
    async claim({ scope, key, fingerprint }) {
      const lease = randomUUID();
      const claimed = await pool.query(
        `INSERT INTO hc_lightspeed_idempotency
          (scope,operation_key,fingerprint,lease,state)
         VALUES ($1,$2,$3,$4::uuid,'pending')
         ON CONFLICT (scope,operation_key) DO NOTHING
         RETURNING lease`,
        [scope,key,fingerprint,lease]
      );
      if (claimed.rowCount === 1) return { state: 'claimed', lease };
      const existing = checkedRow(await pool.query(
        `SELECT fingerprint,state,result
         FROM hc_lightspeed_idempotency WHERE scope=$1 AND operation_key=$2`,
        [scope,key]
      ), 'Existing mutation');
      if (existing.fingerprint !== fingerprint) return { state: 'conflict' };
      if (existing.state === 'verified' && existing.result != null) {
        return { state: 'replay', verified: true, fingerprint, result: existing.result };
      }
      return { state: 'unknown' }; // pending and unknown both require manual reconciliation
    },
    async complete({ scope, key, fingerprint, lease, result, verified }) {
      if (verified !== true || result === null || result === undefined) {
        throw new TypeError('Read-back verified result required.');
      }
      checkedRow(await pool.query(
        `UPDATE hc_lightspeed_idempotency
         SET state='verified',result=$5::jsonb,verified_at=now(),updated_at=now()
         WHERE scope=$1 AND operation_key=$2 AND fingerprint=$3 AND lease=$4::uuid AND state='pending'
         RETURNING scope`,
        [scope,key,fingerprint,lease,JSON.stringify(result)]
      ), 'Mutation verification');
    },
    async markUnknown({ scope, key, fingerprint, lease }) {
      // Never change a verified result into unknown (e.g. failure while writing audit).
      const result = await pool.query(
        `UPDATE hc_lightspeed_idempotency
         SET state='unknown',updated_at=now()
         WHERE scope=$1 AND operation_key=$2 AND fingerprint=$3 AND lease=$4::uuid AND state='pending'
         RETURNING scope`,
        [scope,key,fingerprint,lease]
      );
      if (result?.rowCount !== 1) {
        throw Object.assign(new Error('Mutation was not marked unknown; inspect persistent record.'), {
          code: 'LIGHTSPEED_RECONCILE_REQUIRED'
        });
      }
    }
  });
}
