// DEVELOPMENT CANDIDATE ONLY — not an employee grant or live route policy.
// A split can be enabled only by trusted server configuration for the exact
// PATCH /items/:id/status endpoint. No client field establishes a permission.
//
// Routine status updates must check BOTH target and DB-locked current state.
// Otherwise a staff member could downgrade a received/completed/cancelled
// order by simply asking for an innocent-looking target status.
export const STATUS_PROGRESS_OPERATION = 'special-orders.status.progress';
export const STATUS_SENSITIVE_OPERATION = 'special-orders.status.write';
export const STATUS_POLICY_VERSION = 'locked-transition-v1';

export const ROUTINE_STATUSES = Object.freeze([
  'OOS', 'READY_TO_ORDER', 'BACKORDERED'
]);
export const SENSITIVE_STATUSES = Object.freeze([
  'PREORDER', 'ORDERED', 'RECEIVED', 'HELD',
  'CUSTOMER_NOTIFIED', 'COMPLETED', 'CANCELLED'
]);
export const KNOWN_STATUSES = Object.freeze([
  ...ROUTINE_STATUSES, ...SENSITIVE_STATUSES
]);
const known = new Set(KNOWN_STATUSES);
const routine = new Set(ROUTINE_STATUSES);

export function classifyRequestedStatus(body) {
  // Reject arrays, inherited props, nonstrings, excessive size and unknown
  // values *before* any database/vendor side effect or identity shortcut.
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Object.hasOwn(body, 'status') || typeof body.status !== 'string' ||
      body.status.length < 1 || body.status.length > 32) return null;
  const status = body.status.toUpperCase();
  if (!known.has(status)) return null;
  return Object.freeze({
    status,
    operation: routine.has(status)
      ? STATUS_PROGRESS_OPERATION : STATUS_SENSITIVE_OPERATION
  });
}

export function permitsLockedStatusTransition(admission, previousStatus, requestedStatus) {
  if (!admission || admission.principal !== 'employee' ||
      typeof admission.identityId !== 'string' ||
      !/^[0-9]{1,18}$/.test(admission.identityId) ||
      typeof requestedStatus !== 'string' || !known.has(requestedStatus) ||
      (admission.statusTarget != null && admission.statusTarget !== requestedStatus)) {
    return false;
  }
  if (admission.operation === STATUS_PROGRESS_OPERATION) {
    // A benign target alone NEVER authorizes reopening/changing an item that
    // has ever reached an outside-the-routine state at the time of the lock.
    return admission.statusTarget === requestedStatus &&
      routine.has(previousStatus) && routine.has(requestedStatus);
  }
  if (admission.operation === STATUS_SENSITIVE_OPERATION) {
    // Exact strong grant + independently verified passkey already happened
    // in createStaffAccessBaseline; business transition validation remains.
    return true;
  }
  return false;
}
