// Gateway policy foundation; integrates with existing Timeclock/staff-auth verification.
// This module is not itself an authenticator. Only trusted backend code may construct principals.
const VALID_OPERATION = /^[a-z][a-z0-9_.:-]{2,95}$/;
const DENIED = () => Object.assign(new Error('Lightspeed operation not authorized.'), {
  status: 403, code: 'LIGHTSPEED_FORBIDDEN'
});

export function createLightspeedPolicy({
  verifyEmployee, verifyService, checkPermission,
  writesAllowed = false, productionWritesAllowed = false
} = {}) {
  if (typeof checkPermission !== 'function') throw new TypeError('An explicit permission adapter is required.');

  async function authorize({
    principal, operation, mode, environment = 'production'
  } = {}) {
    if (!VALID_OPERATION.test(String(operation || '')) ||
        !['read', 'write'].includes(mode) ||
        !['production', 'test'].includes(environment) ||
        !['employee', 'service'].includes(principal?.type)) throw DENIED();
    if (mode === 'write' && (!writesAllowed || (environment === 'production' && !productionWritesAllowed))) {
      throw DENIED();
    }
    const verifier = principal.type === 'employee' ? verifyEmployee : verifyService;
    if (typeof verifier !== 'function') throw DENIED();
    let resolved;
    try { resolved = await verifier(principal); } catch { throw DENIED(); }
    // Adapters must return a verified, currently active identity, not a request-supplied claim.
    if (!resolved || resolved.active !== true || !resolved.id) throw DENIED();
    let permitted = false;
    try {
      permitted = await checkPermission({ identity: resolved, type: principal.type, operation, mode, environment });
    } catch { throw DENIED(); }
    if (permitted !== true) throw DENIED();
    return Object.freeze({ identityId: String(resolved.id), identityType: principal.type, operation, mode, environment });
  }
  return Object.freeze({ authorize });
}
