import { TOOL_OPERATIONS } from './adminPermissionCatalog.js';

// Proposed common staff access policy for Hobby Corner tools.
// Candidate only: this module is NOT mounted on any production route.
// Timeclock remains the employee identity source. A 4-digit PIN or an
// employee name by itself MUST NOT authorize an internet-facing tool.
// Keep the existing general operations while tools migrate; none bypass the
// exact backend permission callback. A registered station or verified TOTP is
// suitable for reads, drafts, and Scanner *review* only. Scanner approval in
// the current workflow is staging/review, never a Lightspeed product write.
// Mutation-like actions conservatively require recent phishing-resistant
// employee proof AND a separate exact operation grant. Store workflow owners
// must accept this policy before any feature route enables the guard.
const ROUTINE_TOOL_OPERATIONS = new Set([
  'products.read', 'products.draft',
  'scanner.lookup', 'scanner.stage', 'scanner.approve',
  'purchase-orders.read', 'purchase-orders.draft',
  'inventory.read', 'sales.read', 'store-credit.read',
  'special-orders.read', 'ordering.read', 'consignment.read',
  // Only reversible local notes/routing and unsent supplier-order drafting
  // are candidates for routine verified-station access. Every operation
  // still needs its own independent employee grant; none is pre-granted.
  'special-orders.notes.write', 'special-orders.routing.write',
  // Only transitions between verified local OOS/ready/backorder states are
  // routine. Origin must be verified under the database row lock.
  'special-orders.status.progress', 'ordering.draft.write',
  // These GET-backed operations call Lightspeed read APIs and also upsert the
  // local supplier cache. Keep them routine for store workflow, but distinct
  // from generic ordering/products reads and independently grantable.
  'ordering.suppliers.sync', 'ordering.context.refresh',
  // Local customer contact/profile editing is a routine store task. Live
  // Lightspeed customer mutation remains a separate strong operation.
  'customers.profile.write',
  'timeclock.self.read', 'timeclock.self.clock'
]);
const legacyActions = {
  'timeclock.status': { assurance: 'staff-device', permission: 'timeclock.status' },
  'timeclock.clock': { assurance: 'staff-device', permission: 'timeclock.clock' },
  'tools.read': { assurance: 'staff-device', permission: 'tools.read' },
  'tools.stage': { assurance: 'staff-device', permission: 'tools.stage' },
  'products.write': { assurance: 'step-up', permission: 'products.write' },
  'staff.permissions': { assurance: 'step-up', permission: 'staff.permissions' }
};
const toolActions = Object.fromEntries(TOOL_OPERATIONS.map(operation => [
  operation,
  { assurance: ROUTINE_TOOL_OPERATIONS.has(operation) ? 'staff-device' : 'step-up',
    permission: operation }
]));
const ACTIONS = Object.freeze(Object.fromEntries(
  Object.entries({ ...legacyActions, ...toolActions }).map(([key, policy]) =>
    [key, Object.freeze(policy)])
));
export const STAFF_ACCESS_ACTIONS = ACTIONS;
const DENY = () => Object.assign(new Error('Staff access denied.'), {
  code: 'HC_STAFF_ACCESS_DENIED', status: 403
});
const MAX_STATION_PROOF_MS = 12 * 60 * 60 * 1000;
const MAX_STEP_UP_AGE_MS = 5 * 60 * 1000;
const VALID_METHODS = new Set(['passkey', 'security-key', 'oidc-mfa', 'totp']);
// Time-based codes are useful for remote login, but are not phishing-resistant.
// Keep the privileged-write gate on the pre-existing stronger methods.
const PRIVILEGED_METHODS = new Set(['passkey', 'security-key', 'oidc-mfa']);

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
    let stepUpMethod = null;
    if (typeof verifyStepUp === 'function') {
      try {
        const proof = await verifyStepUp(request, identity);
        stepUpValid = proof?.verified === true &&
          String(proof.employeeId) === identity.id &&
          VALID_METHODS.has(proof.method) &&
          Number.isSafeInteger(proof.authenticatedAtMs) &&
          proof.authenticatedAtMs <= instant &&
          proof.authenticatedAtMs > instant - MAX_STEP_UP_AGE_MS;
        if (stepUpValid) stepUpMethod = proof.method;
      } catch { /* fail closed */ }
    }

    if (definition.assurance === 'step-up'
      ? (!stepUpValid || !PRIVILEGED_METHODS.has(stepUpMethod))
      : !(workstationValid || stepUpValid)) throw DENY();

    let granted = false;
    try { granted = await checkPermission({
      identity, operation: definition.permission, action,
      assurance: stepUpValid ? 'step-up' : 'workstation',
      factorMethod: stepUpMethod
    }) === true; }
    catch { throw DENY(); }
    if (!granted) throw DENY();
    return Object.freeze({
      employeeId: identity.id,
      operation: definition.permission,
      assurance: stepUpValid ? 'step-up' : 'workstation',
      factorMethod: stepUpMethod
    });
  }
  return Object.freeze({ authorize });
}
