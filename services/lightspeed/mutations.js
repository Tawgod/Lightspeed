import { fingerprintLightspeedPayload } from './idempotency.js';

// A single write orchestration contract; not mounted to any HTTP route in Phase 1.
// Caller passes server-verified principal context and durable audit/idempotency adapters.
export function createAuditedLightspeedMutation({ policy, audit, idempotency } = {}) {
  if (typeof policy?.authorize !== 'function' || typeof audit?.record !== 'function' ||
      typeof idempotency?.run !== 'function') throw new TypeError('Policy, audit and idempotency required.');
  return Object.freeze({
    async run({ principal, operation, environment = 'production', tenant, correlationId,
      key, entityType, entityId = null, payload, execute, verifyReadback } = {}) {
      // Scope must isolate tenants AND environments; operation name is not sufficient alone.
      // Caller supplies a trusted tenant key from server configuration.
      const tenantKey = String(tenant || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(tenantKey)) throw new TypeError('Trusted tenant required.');
      const auth = await policy.authorize({ principal, operation, mode: 'write', environment });
      const fingerprint = fingerprintLightspeedPayload(payload);
      const scope = environment + ':' + tenantKey + ':' + operation;
      const event = { correlationId, operation, actorType: auth.identityType,
        actorId: auth.identityId, entityType, entityId, fingerprint };
      // Fail closed before attempting a Lightspeed write if audit is unavailable.
      await audit.record({ ...event, stage: 'requested' });
      try {
        const response = await idempotency.run({ key, scope, payload, execute, verifyReadback });
        await audit.record({ ...event, stage: 'verified',
          outcome: response.replayed ? 'verified_replay' : 'verified_write' });
        return response;
      } catch (error) {
        try {
          await audit.record({ ...event, stage: error?.mayHaveWritten ? 'unknown' : 'rejected',
            outcome: String(error?.code || 'mutation_error') });
        } catch {
          // Persistent idempotency still prevents a second write; do not mask first failure.
        }
        throw error;
      }
    }
  });
}
