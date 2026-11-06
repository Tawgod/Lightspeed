import { fingerprintLightspeedPayload } from './idempotency.js';

// Write orchestration contract; deliberately NOT mounted to an HTTP route in Phase 1.
// Tenant/environment must be supplied only in trusted backend configuration.
export function createAuditedLightspeedMutation({
  policy, audit, idempotency, tenant, environment = 'production'
} = {}) {
  if (typeof policy?.authorize !== 'function' || typeof audit?.record !== 'function' ||
      typeof idempotency?.run !== 'function') throw new TypeError('Policy, audit and idempotency required.');
  const tenantKey = String(tenant || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(tenantKey) ||
      !['production','test'].includes(environment)) throw new TypeError('Trusted tenant/environment required.');
  return Object.freeze({
    async run({ principal, operation, correlationId, key,
      entityType, entityId = null, payload, execute, verifyReadback } = {}) {
      const auth = await policy.authorize({ principal, operation, mode: 'write', environment });
      const fingerprint = fingerprintLightspeedPayload(payload);
      const scope = environment + ':' + tenantKey + ':' + operation;
      const event = { correlationId, operation, actorType: auth.identityType,
        actorId: auth.identityId, entityType, entityId, fingerprint };
      // Refuse to initiate a vendor write if durable audit persistence is unavailable.
      await audit.record({ ...event, stage: 'requested' });
      let response;
      try {
        response = await idempotency.run({ key, scope, payload, execute, verifyReadback });
      } catch (error) {
        try {
          await audit.record({ ...event, stage: error?.mayHaveWritten ? 'unknown' : 'rejected',
            outcome: String(error?.code || 'mutation_error') });
        } catch { /* Original failure remains authoritative; idempotency still blocks unsafe retry. */ }
        throw error;
      }
      // If this append fails after store verification, the idempotency record remains
      // verified: repeated requests replay instead of repeating the external mutation.
      await audit.record({ ...event, stage: 'verified',
        outcome: response.replayed ? 'verified_replay' : 'verified_write' });
      return response;
    }
  });
}
