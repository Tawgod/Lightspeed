// Append-only mutation audit contract. Production consumers must provide a durable append adapter.
// Deliberately records metadata and fingerprints, not customer data or credentials.
const STAGES = new Set(['requested', 'verified', 'rejected', 'unknown']);
const validString = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

export function createLightspeedAudit({ append, now = () => new Date().toISOString() } = {}) {
  if (typeof append !== 'function') throw new TypeError('Durable append-only audit adapter required.');
  async function record({
    stage, correlationId, operation, actorType, actorId,
    entityType, entityId = null, fingerprint, outcome = null
  } = {}) {
    if (!STAGES.has(stage) || !validString(correlationId) || !validString(operation) ||
        !['employee', 'service'].includes(actorType) || !validString(actorId) ||
        !validString(entityType) || !validString(fingerprint)) {
      throw new TypeError('Invalid audit record metadata.');
    }
    const event = Object.freeze({
      timestamp: now(), stage, correlationId, operation,
      actorType, actorId, entityType,
      entityId: entityId === null ? null : String(entityId),
      fingerprint, outcome: outcome === null ? null : String(outcome).slice(0, 120)
    });
    try {
      const receipt = await append(event);
      if (!receipt || !receipt.id) throw new Error('Audit append unconfirmed.');
      return Object.freeze({ eventId: String(receipt.id) });
    } catch {
      const error = new Error('Lightspeed audit persistence unavailable; operation cannot proceed safely.');
      error.code = 'LIGHTSPEED_AUDIT_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
  }
  return Object.freeze({ record });
}
