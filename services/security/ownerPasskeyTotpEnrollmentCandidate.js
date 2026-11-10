import {createCanonicalStaffFactorSession} from './primaryLiveTotpEnrollmentGate.js';
import {createStaffSecuritySubsystem} from './staffSecuritySubsystem.js';

// UNMOUNTED TEST CANDIDATE. After initial Owner has a genuine registered
// WebAuthn passkey, allow Owner to approve enrollment of TOTP on THEIR OWN
// same canonical Timeclock identity via the existing durable approval pipeline.
// No independent business identity provider and no PIN-only approval.
// Production requires reviewed origin, CSRF, DB privileges and real WebAuthn.
const ID=/^[1-9][0-9]{0,17}$/;
const denied=()=>Object.assign(new Error('Fresh Owner passkey required.'),{
 status:403,code:'HC_OWNER_TOTP_APPROVAL_DENIED'
});
export function createOwnerPasskeyTotpEnrollmentCandidate({
 environment,enabled=false,expectedOwnerEmployeeId,staffAuthGateway,
 timeclockIdentity,pool,verifyOwnerPasskey,
 totpEncryptionKey,throttleHmacSecret,approvalHmacSecret,mfaSessionSecret,
 now=()=>Date.now(),createSubsystem=createStaffSecuritySubsystem
}={}){
 const ownerId=String(expectedOwnerEmployeeId??'');
 if(environment!=='test'||enabled!==true||!ID.test(ownerId)||
   typeof pool?.connect!=='function'||typeof verifyOwnerPasskey!=='function'||
   typeof now!=='function'||typeof createSubsystem!=='function')
  throw new TypeError('Explicit test-only Owner identity and a verified passkey are required.');
 const canonical=createCanonicalStaffFactorSession({
  staffAuthGateway,timeclockIdentity,now
 });
 async function activeOwner(employeeId){
  if(employeeId!==ownerId)return false;
  let client;
  try{
   client=await pool.connect();
   const result=await client.query(
    "SELECT 1 FROM hc_admin_principals WHERE employee_id=$1 AND role='owner' AND active=true",
    [ownerId]
   );
   return result.rowCount===1;
  }catch{return false;}finally{client?.release();}
 }
 async function verifiedOwner(context){
  let person,proof;
  try{
   person=await canonical.verifyBoundEmployee(context);
   proof=await verifyOwnerPasskey(context);
  }catch{throw denied();}
  const t=now();
  if(person.id!==ownerId||proof?.verified!==true||
    String(proof.employeeId??proof.id)!==ownerId||
    !['passkey','security-key'].includes(proof.method)||
    !Number.isSafeInteger(proof.authenticatedAtMs)||
    proof.authenticatedAtMs>t||proof.authenticatedAtMs<=t-5*60_000||
    !(await activeOwner(ownerId)))throw denied();
  return Object.freeze({id:ownerId,active:true,
    method:proof.method,authenticatedAtMs:proof.authenticatedAtMs});
 }
 async function canApproveEnrollment({context,approverId,employeeId,operation}={}){
  if(operation!=='staff.authenticator.enroll'||String(approverId)!==ownerId||
    String(employeeId)!==ownerId)return false;
  try{await verifiedOwner(context);return true;}catch{return false;}
 }
 const security=createSubsystem({
  staffAuthGateway:canonical,pool,
  totpEncryptionKey,throttleHmacSecret,approvalHmacSecret,mfaSessionSecret,
  verifyStrongManager:verifiedOwner,
  canApproveEnrollment,
  // Factor replacement/recovery must remain a distinct protected process.
  canRecoverFactor:async()=>false,
  now
 });
 if(typeof security?.settingsRouter!=='function'||
    typeof security?.verifyTotpStepUp!=='function')
  throw new TypeError('Existing encrypted TOTP subsystem required.');
 return Object.freeze({
  settingsRouter:security.settingsRouter,
  verifyTotpStepUp:security.verifyTotpStepUp
 });
}
