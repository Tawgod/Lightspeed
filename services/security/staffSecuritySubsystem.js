import { createPostgresStaffLoginThrottle } from './staffLoginThrottle.js';
import { createPostgresStaffEnrollmentApprovals } from './staffEnrollmentApprovals.js';
import { createStaffApprovedEnrollmentAdapters } from './staffEnrollmentSettings.js';
import { createPostgresStaffTotp } from './staffTotpPostgres.js';
import { createStaffMfaSessions } from './staffMfaSessions.js';
import { createStaffFactorRecovery } from './staffFactorRecovery.js';
import { createStaffSecuritySettingsRouter } from '../../routes/staffSecuritySettings.js';

// An unmounted, complete composition of the employee security candidates.
// Never supply demo verifiers in production. A PIN-only manager or browser role
// MUST NOT approve enrollment or recovery. The hosting service must resolve a
// strong manager's verified ID/permission from an independent trusted IdP.
export function createStaffSecuritySubsystem({
  staffAuthGateway, pool, totpEncryptionKey, throttleHmacSecret,
  approvalHmacSecret, mfaSessionSecret,
  verifyStrongManager, canApproveEnrollment, canRecoverFactor,
  now = () => Date.now()
} = {}) {
  if (typeof staffAuthGateway?.verifyBoundEmployee !== 'function' ||
      typeof pool?.connect !== 'function' ||
      typeof verifyStrongManager !== 'function' ||
      typeof canApproveEnrollment !== 'function' ||
      typeof canRecoverFactor !== 'function') {
    throw new TypeError('Trusted Timeclock, PostgreSQL and independent manager authentication required.');
  }
  const verifyBase = req => staffAuthGateway.verifyBoundEmployee(req);
  const totpThrottle = createPostgresStaffLoginThrottle({
    pool, secret: throttleHmacSecret, scope: 'hc:staff:totp'
  });
  const approvalThrottle = createPostgresStaffLoginThrottle({
    pool, secret: throttleHmacSecret, scope: 'hc:staff:factor-enrollment'
  });
  const approvals = createPostgresStaffEnrollmentApprovals({
    pool, secret: approvalHmacSecret, now,
    verifyEmployeeSession: verifyBase,
    getSessionBinding: async context => (await verifyBase(context)).binding,
    verifyStrongApprover: verifyStrongManager,
    canApprove: canApproveEnrollment,
    throttle: approvalThrottle
  });
  const gates = createStaffApprovedEnrollmentAdapters({ approvals });
  const totp = createPostgresStaffTotp({
    pool, encryptionKey: totpEncryptionKey,
    verifyEmployeeSession: verifyBase,
    authorizeEnrollment: gates.authorizeEnrollment,
    loginThrottle: totpThrottle,
    now
  });
  const mfa = createStaffMfaSessions({
    secret: mfaSessionSecret, verifyBaseSession: verifyBase,
    totp, now
  });
  const recovery = createStaffFactorRecovery({
    pool, verifyStrongManager, canRecover: canRecoverFactor, now
  });
  const settingsRouter = createStaffSecuritySettingsRouter({
    verifyEmployee: verifyBase, authorizeSettings: gates.authorizeSettings,
    totp, approvals, mfa
  });
  // Pass only to backend operation policy. Never accept a client-supplied
  // proof object; this method verifies HMAC, base session and factor version.
  async function verifyTotpStepUp(request) {
    return mfa.verify({ context: request, token: request.get('x-hc-mfa-session') });
  }
  return Object.freeze({ settingsRouter, verifyTotpStepUp, recovery });
}
