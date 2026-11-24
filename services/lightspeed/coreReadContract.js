import { randomUUID } from 'node:crypto';
import { LightspeedTransportError } from './client.js';
import { LightspeedIncompleteReadError } from './readCollection.js';

// Additive candidate; no existing HTTP route uses this contract.
export const CORE_READ_VERSION = 'core.v1';
const OPERATION = /^[a-z][a-z0-9_.:-]{2,95}$/;
const TRACE = /^[A-Za-z0-9_.:-]{1,128}$/;
const messages = Object.freeze({
  CORE_FORBIDDEN: 'Read operation not authorized.',
  CORE_UNAVAILABLE: 'Shared read service unavailable.',
  LIGHTSPEED_INCOMPLETE_READ: 'Lightspeed read incomplete.',
  LIGHTSPEED_NETWORK: 'Lightspeed connection unavailable.',
  LIGHTSPEED_HTTP: 'Lightspeed rejected the read.',
  LIGHTSPEED_RESPONSE: 'Lightspeed response could not be read safely.',
  LIGHTSPEED_RESPONSE_JSON: 'Lightspeed response was invalid.'
});
function failure(code, correlationId, retryable = false, status = 502) {
  return { status, body: { version: CORE_READ_VERSION, readOnly: true, correlationId,
    error: { code, message: messages[code], retryable } } };
}

// Security owns the injected admission verifier. It must independently verify
// identity and the exact operation grant; this module never authenticates anyone.
// A literal true is required; truthy objects and verifier outages fail closed.
export function createCoreReadExecutor({ authorizeRead, environment } = {}) {
  if (typeof authorizeRead !== 'function' || !['test','production'].includes(environment)) {
    throw new TypeError('Explicit Security admission adapter and environment required.');
  }
  return async function execute({ operation, context, read } = {}) {
    const correlationId = randomUUID();
    if (typeof operation !== 'string' || !OPERATION.test(operation) || typeof read !== 'function') {
      throw new TypeError('Invalid server-owned read operation.');
    }
    let granted;
    try { granted = await authorizeRead({ operation, context, mode: 'read', environment, correlationId }); }
    catch { return failure('CORE_FORBIDDEN', correlationId, false, 403); }
    if (granted !== true) return failure('CORE_FORBIDDEN', correlationId, false, 403);
    try {
      const data = await read({ correlationId });
      if (data === undefined) return failure('CORE_UNAVAILABLE', correlationId, false, 503);
      return { status: 200, body: { version: CORE_READ_VERSION, readOnly: true, correlationId, data } };
    } catch (error) {
      if (error instanceof LightspeedIncompleteReadError) return failure('LIGHTSPEED_INCOMPLETE_READ', correlationId);
      if (error instanceof LightspeedTransportError && !error.mayHaveWritten &&
          ['LIGHTSPEED_NETWORK','LIGHTSPEED_HTTP','LIGHTSPEED_RESPONSE','LIGHTSPEED_RESPONSE_JSON'].includes(error.code)) {
        return failure(error.code, correlationId, error.retryable === true);
      }
      return failure('CORE_UNAVAILABLE', correlationId, false, 503);
    }
  };
}
