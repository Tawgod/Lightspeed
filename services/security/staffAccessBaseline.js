// Proposed common staff access policy for Hobby Corner tools.
// Candidate only: this module is NOT mounted on any production route.
// Timeclock remains the employee identity source. A 4-digit PIN or an
// employee name by itself MUST NOT authorize an internet-facing tool.
const ACTIONS = Object.freeze({
  'timeclock.status': Object.freeze({ assurance: 'staff-device', permission: 'timeclock.status' }),
  'timeclock.clock': Object.freeze({ assurance: 'staff-device', permission: 'timeclock.clock' }),
  'tools.read': Object.freeze({ assurance: 'staff-device', permission: 'tools.read' }),
  'tools.stage': Object.freeze({ assurance: 'staff-device', permission: 'tools.stage' }),
  'products.write': Object.freeze({ assurance: 'step-up', permission: 'products.write' }),
  'purchase-orders.write': Object.freeze({ assurance: 'step-up', permission: 'purchase-orders.write' }),
  'inventory.adjust': Object.freeze({ assurance: 'step-up', permission: 'inventory.adjust' }),
  'sales.write': Object.freeze({ assurance: 'step-up', permission: 'sales.write' }),
  'store-credit.write': Object.freeze({ assurance: 'step-up', permission: 'store-credit.write' }),
  'staff.permissions': Object.freeze({ assurance: 'step-up', permission: 'staff.permissions' })
});
export const STAFF_ACCESS_ACTIONS = ACTIONS;
const DENY = () => Object.assign(new Error('Staff access denied.'), {
  code: 'HC_STAFF_ACCESS_DENIED', status: 403
});
const MAX_STATION_PROOF_MS = 12 * 60 * 60 * 1000;
const MAX_STEP_UP_AGE_MS = 5 * 60 * 1000;
const VALID_METHODS = new Set(['passkey', 'security-key', 'oidc-mfa']);

/**
 * Only backend-owned verifiers may confirm a station or a second factor.
 * Do NOT connect these to request headers, body, client cookies or Origin alone.
 * verifyEmployeeSession must validate a server-signed session AND fresh active
 * status in Timeclock; the method is not a replacement login implementation.
 *
 * Verification callbacks should be cryptographic / IDP-validated:
 * - verifyWorkstation(req, employee) returns { verified:true, deviceId,
 *   expiresAtMs } ONLY for a registered device proof validated server-side.
 * - verifyStepUp(req, employee) returns { verified:true, employeeId, method,
 *   authenticatedAtMs } ONLY for a cryptographically validated second factor.
 * - checkPermission is a backend-only exact operation grant, never role data
 *   supplied from a browser request.
 */
export function createStaffAccessBaseline({
  verifyEmployeeSession, verifyWorkstation, verifyStepUp, checkPermission,
  now = () => Date.now()
} = {}) {
  if (typeof verifyEmployeeSession !== 'function' ||
      typeof checkPermission !== 'function' ||
      typeof now !== 'function') {
    throw new TypeError('Verified employee session, exact permission, and clock adapters required.');
  }
  if (verifyWorkstation !== undefined && typeof verifyWorkstation !== 'function') {
    throw new TypeError('Workstation verifier must be a function.');
  }
  if (verifyStepUp !== undefined && typeof verifyStepUp !== 'function') {
    throw new TypeError('Step-up verifier must be a function.');
  }

  async function authorize({ request, action } = {}) {
    const definition = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!definition || !request) throw DENY();
    let employee;
    try { employee = await verifyEmployeeSession(request); }
    catch { throw DENY(); }
    if (!employee || employee.active !== true ||
        !/^[0-9]{1,18}$/.test(String(employee.id || ''))) throw DENY();

    const identity = Object.freeze({ id: String(employee.id), active: true });
    const instant = now();
    if (!Number.isSafeInteger(instant)) throw DENY();

    // A PIN-derived session alone is insufficient for ANY public staff tool.
    // A trusted in-store device or independent, fresh strong authentication
    // must be verified by a separate server-only adapter.
    let workstationValid = false;
    if (typeof verifyWorkstation === 'function') {
      try {
        const device = await verifyWorkstation(request, identity);
        workstationValid = device?.verified === true &&
          typeof device.deviceId === 'string' && device.deviceId.length > 0 &&
          device.deviceId.length <= 128 &&
          Number.isSafeInteger(device.expiresAtMs) &&
          device.expiresAtMs > instant &&
          device.expiresAtMs <= instant + MAX_STATION_PROOF_MS;
      } catch { /* fail closed */ }
    }

    let stepUpValid = false;
    if (typeof verifyStepUp === 'function') {
      try {
        const proof = await verifyStepUp(request, identity);
        stepUpValid = proof?.verified === true &&
          String(proof.employeeId) === identity.id &&
          VALID_METHODS.has(proof.method) &&
          Number.isSafeInteger(proof.authenticatedAtMs) &&
          proof.authenticatedAtMs <= instant &&
          proof.authenticatedAtMs > instant - MAX_STEP_UP_AGE_MS;
      } catch { /* fail closed */ }
    }

    if (definition.assurance === 'step-up'
      ? !stepUpValid : !(workstationValid || stepUpValid)) throw DENY();

    let granted = false;
    try { granted = await checkPermission({
      identity, operation: definition.permission, action,
      assurance: stepUpValid ? 'step-up' : 'workstation'
    }) === true; }
    catch { throw DENY(); }
    if (!granted) throw DENY();
    return Object.freeze({
      employeeId: identity.id,
      operation: definition.permission,
      assurance: stepUpValid ? 'step-up' : 'workstation'
    });
  }
  return Object.freeze({ authorize });
}
