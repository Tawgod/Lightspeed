import { createHash } from 'node:crypto';

// Atomic durable-store contract. Never substitute an in-process Map for production mutations.
// Fingerprints must describe the JSON that can actually be sent over HTTP.
// Reject Date/toJSON/class instances, accessors, circular objects and non-JSON data:
// otherwise distinct wire payloads could accidentally share an idempotency key.
const MAX_NODES = 20000;
const MAX_DEPTH = 64;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
function canonical(value, seen = new WeakSet(), budget = { nodes: 0 }, depth = 0) {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw new TypeError('Mutation payload exceeds safety limits.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite payload value.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('Unsupported payload value.');
  if (seen.has(value)) throw new TypeError('Cyclic mutation payload.');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new TypeError('Mutation payload must use plain JSON objects.');
  }
  if (Object.getOwnPropertySymbols(value).length || Object.hasOwn(value, 'toJSON')) {
    throw new TypeError('Mutation payload contains non-JSON behavior.');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const parts = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) throw new TypeError('Sparse mutation arrays are not allowed.');
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('Mutation payload accessors are not allowed.');
        parts.push(canonical(descriptor.value, seen, budget, depth + 1));
      }
      return '[' + parts.join(',') + ']';
    }
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Mutation payload accessors are not allowed.');
      }
      parts.push(JSON.stringify(key) + ':' + canonical(descriptor.value, seen, budget, depth + 1));
    }
    return '{' + parts.join(',') + '}';
  } finally {
    seen.delete(value);
  }
}

function canonicalPayload(value) {
  const json = canonical(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new TypeError('Mutation payload exceeds maximum serialized size.');
  }
  return json;
}

export function fingerprintLightspeedPayload(payload) {
  return createHash('sha256').update(canonicalPayload(payload)).digest('hex');
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
    // Give the writer a detached JSON snapshot, not a mutable caller-owned object.
    const approvedPayload = JSON.parse(canonicalPayload(payload));
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
      if (fingerprintLightspeedPayload(payload) !== fingerprint) {
        throw invalid('LIGHTSPEED_PAYLOAD_CHANGED');
      }
      attempted = true;
      const result = await execute(approvedPayload);
      if (fingerprintLightspeedPayload(payload) !== fingerprint) {
        throw invalid('LIGHTSPEED_PAYLOAD_CHANGED', 503);
      }
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
