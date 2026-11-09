import {createCanonicalStaffFactorSession,
  createCanonicalStaffFactorApprovalPolicy} from './primaryLiveTotpEnrollmentGate.js';
import {createStaffSecuritySubsystem} from './staffSecuritySubsystem.js';

// UNMOUNTED composition of existing Timeclock + durable staff enrollment/TOTP.
// Only build a test candidate with reviewed, independently provisioned secrets.
// A staff PIN may begin an approval REQUEST, not bypass the strong approver.
// No Owner auto-bootstrap or test-factor transfer is implemented here.
export function createPrimaryTimeclockTotpSubsystem({
  environment, enabled=false, staffAuthGateway,timeclockIdentity,pool,
  totpEncryptionKey,throttleHmacSecret,approvalHmacSecret,mfaSessionSecret,
  verifyStrongApprover,canApproveEnrollment,canRecoverFactor,
  now=()=>Date.now(),createSubsystem=createStaffSecuritySubsystem
}={}) {
  if(environment!=='test'||enabled!==true||
     typeof pool?.connect!=='function'||typeof createSubsystem!=='function'||
     typeof now!=='function')throw new TypeError('Test-only approved primary enrollment composition required.');
  const canonical=createCanonicalStaffFactorSession({
    staffAuthGateway,timeclockIdentity,now
  });
  const approval=createCanonicalStaffFactorApprovalPolicy({
    verifyStrongApprover,canApproveEnrollment,canRecoverFactor,now
  });
  const subsystem=createSubsystem({
    staffAuthGateway:canonical,pool,totpEncryptionKey,throttleHmacSecret,
    approvalHmacSecret,mfaSessionSecret,
    verifyStrongManager:approval.verifyStrongApprover,
    canApproveEnrollment:approval.canApproveEnrollment,
    canRecoverFactor:approval.canRecoverFactor,
    // Direct employee PIN-initiated enrollment REQUESTS are allowed in the
    // existing settings router; grants/QR remain independent and durable.
    now
  });
  if(typeof subsystem?.settingsRouter!=='function'||
     typeof subsystem?.verifyTotpStepUp!=='function')
    throw new TypeError('Approved encrypted TOTP subsystem incomplete.');
  return Object.freeze({
    settingsRouter:subsystem.settingsRouter,
    verifyTotpStepUp:subsystem.verifyTotpStepUp
  });
}
