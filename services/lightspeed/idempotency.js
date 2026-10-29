import { createHash } from 'node:crypto';

// Atomic durable-store contract. Never substitute an in-process Map for production mutations.
function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite payload value.');
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError('Unsupported payload value.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

export function fingerprintLightspeedPayload(payload) {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}
const invalid = (code, status = 409) => Object.assign(new Error('Lightspeed mutation cannot be safely repeated.'), { code, status });

export function createLightspeedIdempotency({ store } = {}) {
  if (!store || ['claim', 'complete', 'markUnknown'].some(name => typeof store[name] !== 'function')) {
    throw new TypeError('Atomic persistent idempotency store required.');
  }
  async function run({ key, scope, payload, execute, verifyReadback } = {}) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{8,150}$/.test(key) ||
        typeof scope !== 'string' || !/^[a-z][a-z0-9_.:-]{2,95}$/.test(scope) ||
        typeof execute !== 'function' || typeof verifyReadback !== 'function') throw new TypeError('Invalid idempotent mutation contract.');
    const fingerprint = fingerprintLightspeedPayload(payload);
    // The adapter MUST atomically reserve the (scope,key), retain the fingerprint,
    // and return an exclusive lease token only for a fresh claim.
    const claim = await store.claim({ scope, key, fingerprint });
    if (claim?.state === 'replay' && claim.verified === true && claim.fingerprint === fingerprint) {
      return Object.freeze({ result: claim.result, replayed: true });
    }
    if (claim?.state === 'conflict') throw invalid('LIGHTSPEED_KEY_CONFLICT');
    if (claim?.state !== 'claimed' || !claim.lease) throw invalid('LIGHTSPEED_MUTATION_UNKNOWN');

    let attempted = false;
    try {
      attempted = true;
      const result = await execute();
      if ((await verifyReadback(result)) !== true) throw invalid('LIGHTSPEED_READBACK_UNKNOWN', 503);
      await store.complete({ scope, key, fingerprint, lease: claim.lease, result, verified: true });
      return Object.freeze({ result, replayed: false });
    } catch (cause) {
      if (attempted) {
        try {
          await store.markUnknown({ scope, key, fingerprint, lease: claim.lease });
        } catch { /* Do not retry a potentially successful write after store failure. */ }
      }
      const err = invalid('LIGHTSPEED_MUTATION_UNKNOWN', 503);
      err.mayHaveWritten = attempted;
      err.cause = cause;
      throw err;
    }
  }
  return Object.freeze({ run });
}
