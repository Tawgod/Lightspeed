import { createStaffAccessBaseline } from './staffAccessBaseline.js';

// DEVELOPMENT CANDIDATE ONLY. The shared Timeclock gateway must verify the
// HMAC-signed staff session AND query Timeclock for current active status.
// Neither this bridge nor the MFA service is mounted by this module.
const EMPLOYEE = /^[1-9][0-9]{0,17}$/;
const BINDING = /^[A-Za-z0-9_.:-]{16,256}$/;
const METHODS = new Set(['passkey', 'security-key', 'oidc-mfa']);
const denied = () => Object.assign(new Error('Verified staff session required.'), {
  code: 'HC_STAFF_SESSION_REQUIRED', status: 401
});

export function createStaffBoundSessionAdapter({
  staffAuth, now = () => Date.now()
} = {}) {
  if (typeof staffAuth?.verifyBoundEmployee !== 'function' || typeof now !== 'function') {
    throw new TypeError('Verified, employee-bound Timeclock sessions are required.');
  }

  async function bound(request) {
    if (!request) throw denied();
    let session;
    try { session = await staffAuth.verifyBoundEmployee(request); }
    catch { throw denied(); }
    const current = now();
    if (!Number.isSafeInteger(current) ||
        session?.active !== true ||
        !EMPLOYEE.test(String(session.id || '')) ||
        String(session.employeeId || session.id) !== String(session.id) ||
        typeof session.binding !== 'string' || !BINDING.test(session.binding) ||
        !Number.isSafeInteger(session.expiresAtMs) ||
        session.expiresAtMs <= current) throw denied();
    return session;
  }

  async function verifyEmployeeSession(request) {
    const session = await bound(request);
    return Object.freeze({ id: String(session.id), active: true });
  }

  async function verifyBaseSession(request) {
    const session = await bound(request);
    return Object.freeze({
      employeeId: String(session.id), active: true, binding: session.binding
    });
  }

  return Object.freeze({
    verifyEmployeeSession, verifyEmployee: verifyEmployeeSession,
    verifyBaseSession
  });
}

export function createStaffSecurityAccessGate({
  staffSession, mfa, checkPermission, verifyWorkstation,
  verifyStrongStepUp, now = () => Date.now()
} = {}) {
  if (typeof staffSession?.verifyEmployeeSession !== 'function' ||
      typeof staffSession?.verifyBaseSession !== 'function' ||
      typeof mfa?.verify !== 'function' || typeof checkPermission !== 'function' ||
      typeof now !== 'function' ||
      (verifyWorkstation !== undefined && typeof verifyWorkstation !== 'function') ||
      (verifyStrongStepUp !== undefined && typeof verifyStrongStepUp !== 'function')) {
    throw new TypeError('Trusted staff, MFA, operation permission and assurance adapters required.');
  }

  async function verifyStepUp(request, employee) {
    // Strong proof MUST come from a server-side passkey/security-key/IdP
    // verifier. Never pass through client role, Origin, or "verified" headers.
    if (typeof verifyStrongStepUp === 'function') {
      try {
        const proof = await verifyStrongStepUp(request, employee);
        if (proof?.verified === true &&
            String(proof.employeeId) === String(employee.id) &&
            METHODS.has(proof.method) &&
            Number.isSafeInteger(proof.authenticatedAtMs)) return Object.freeze({
          verified: true, employeeId: String(employee.id),
          method: proof.method, authenticatedAtMs: proof.authenticatedAtMs
        });
      } catch { /* deny strong proof; never trust an unverified response */ }
    }
    const token = typeof request?.get === 'function'
      ? request.get('x-hc-mfa-session') : undefined;
    if (typeof token !== 'string' || !token) return null;
    try {
      const proof = await mfa.verify({ context: request, token });
      if (proof?.verified !== true || proof.method !== 'totp' ||
          String(proof.employeeId) !== String(employee.id) ||
          !Number.isSafeInteger(proof.authenticatedAtMs)) return null;
      return Object.freeze({
        verified: true, employeeId: String(employee.id),
        method: 'totp', authenticatedAtMs: proof.authenticatedAtMs
      });
    } catch { return null; }
  }

  const policy = createStaffAccessBaseline({
    verifyEmployeeSession: staffSession.verifyEmployeeSession,
    verifyWorkstation, verifyStepUp, checkPermission, now
  });
  return Object.freeze({ authorize: policy.authorize, verifyStepUp });
}
