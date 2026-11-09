// Read-only primary employee security commissioning preflight.
// No test identity, authenticator seed or PIN is copied. This module never
// grants Owner permissions, enrolls factors, or changes Timeclock records.
const ID = /^[1-9][0-9]{0,17}$/;
const BINDING = /^[A-Za-z0-9_.:-]{16,256}$/;
const FACTOR_STATES = new Set(['not_enrolled','pending','active','revoked']);
const denied = () => Object.assign(new Error('Primary employee verification required.'), {
  code:'HC_PRIMARY_EMPLOYEE_DENIED', status:403
});
const unavailable = () => Object.assign(new Error('Primary employee readiness unavailable.'), {
  code:'HC_PRIMARY_EMPLOYEE_UNAVAILABLE',status:503
});

export function createPrimaryEmployeeSecurityReadiness({
  verifyBoundEmployee, checkOwnerAssignment, readPrimaryFactorStatus,
  verifyPrimaryFactorProof, now=()=>Date.now()
}={}) {
  if ([verifyBoundEmployee,checkOwnerAssignment,readPrimaryFactorStatus,
       verifyPrimaryFactorProof,now].some(fn=>typeof fn!=='function'))
    throw new TypeError('Trusted Timeclock session, Owner verification and factor adapters required.');

  async function inspect({context}={}) {
    if(!context)throw denied();
    let employee;
    try {employee=await verifyBoundEmployee(context);}
    catch {throw denied();}
    const current=now();
    if(!Number.isSafeInteger(current) || employee?.active!==true ||
      !ID.test(String(employee.id||'')) ||
      String(employee.employeeId||employee.id)!==String(employee.id) ||
      !BINDING.test(employee.binding) ||
      !Number.isSafeInteger(employee.expiresAtMs) ||
      employee.expiresAtMs<=current)throw denied();
    const id=String(employee.id);

    // Enrollment is not a way to assign oneself the Owner role. The role
    // must already be supported by independent trusted Timeclock/Admin data.
    let isOwner;
    try {isOwner=await checkOwnerAssignment({employeeId:id,context});}
    catch {throw denied();}
    if(isOwner!==true)throw denied();

    // A synthetic staging passkey/TOTP proof for employee 901 cannot be
    // "transferred" to the real employee. Only an independently verified
    // employee-bound proof for THIS signed session is accepted.
    let proof;
    try {proof=await verifyPrimaryFactorProof({context,employeeId:id});}
    catch {throw denied();}
    if(proof?.verified!==true || String(proof.employeeId)!==id ||
      !['passkey','security-key','oidc-mfa'].includes(proof.method) ||
      !Number.isSafeInteger(proof.authenticatedAtMs) ||
      proof.authenticatedAtMs>current ||
      proof.authenticatedAtMs<=current-5*60_000)throw denied();

    let factor;
    try {factor=await readPrimaryFactorStatus({context,employeeId:id});}
    catch {throw unavailable();}
    if(!FACTOR_STATES.has(factor?.state))throw unavailable();

    return Object.freeze({
      employeeId:id,
      employeeActive:true,
      independentlyVerifiedOwner:true,
      primaryAuthenticator:factor.state,
      requiresSeparateEnrollment:factor.state!=='active',
      // No mutation, permission elevation, credential copy or account merge.
      readOnly:true,
      testIdentityTransferAllowed:false
    });
  }
  return Object.freeze({inspect});
}
