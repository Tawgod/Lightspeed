import {createPrimaryTimeclockCanonicalReader} from './primaryTimeclockCanonicalReader.js';

// Candidate only; not mounted by server.js. Wraps the existing signed staff
// session so ALL downstream factor enrollment/verification operations are bound
// to the same active, authoritative Timeclock employee ID.
//
// This is NOT a PIN verifier, Owner bootstrap or factor approval: the existing
// Postgres enrollment approvals MUST independently require a strong manager
// passkey/security-key/verified IdP MFA and exact permission on every request.
const ID=/^[1-9][0-9]{0,17}$/;
const BIND=/^[A-Za-z0-9_.:-]{16,256}$/;
const forbidden=()=>Object.assign(new Error('Canonical signed employee session required.'),{
  status:403,code:'HC_PRIMARY_TOTP_SESSION_DENIED'
});
const unavailable=()=>Object.assign(new Error('Canonical employee status unavailable.'),{
  status:503,code:'HC_PRIMARY_TOTP_SESSION_UNAVAILABLE'
});

export function createCanonicalStaffFactorSession({
  staffAuthGateway,timeclockIdentity,now=()=>Date.now()
}={}) {
  if(typeof staffAuthGateway?.verifyBoundEmployee!=='function'||
     typeof timeclockIdentity?.authorize!=='function'||typeof now!=='function')
    throw new TypeError('Signed staff session and authoritative Timeclock reader required.');
  const canonical=createPrimaryTimeclockCanonicalReader({timeclockIdentity});
  async function verifyBoundEmployee(context) {
    if(!context)throw forbidden();
    let staff;
    try{staff=await staffAuthGateway.verifyBoundEmployee(context);}
    catch{throw forbidden();}
    const time=now(),id=String(staff?.id??'');
    if(!Number.isSafeInteger(time)||time<0||staff?.active!==true||
       !ID.test(id)||String(staff.employeeId??staff.id)!==id||
       !BIND.test(staff.binding)||!Number.isSafeInteger(staff.expiresAtMs)||
       staff.expiresAtMs<=time)throw forbidden();

    // This is the same backend-only Timeclock service authorize endpoint
    // used by the existing Scanner. It rechecks active employee state; a
    // synthetic isolated-staging identity fails the provenance check.
    try {
      const verified=await canonical.verifyCanonicalTimeclockEmployee({employeeId:id});
      if(verified?.active!==true||verified.employeeId!==id)throw forbidden();
    }catch(error){
      if(error?.code==='HC_CANONICAL_EMPLOYEE_DENIED')throw forbidden();
      if(error?.code==='HC_CANONICAL_EMPLOYEE_UNAVAILABLE')throw unavailable();
      throw forbidden();
    }
    return Object.freeze({
      id,employeeId:id,active:true,binding:staff.binding,expiresAtMs:staff.expiresAtMs
    });
  }
  return Object.freeze({verifyBoundEmployee});
}

// Preflight to avoid accidentally exposing the factor setup route with an
// uncommissioned independent approver. Startup must reject missing callbacks
// rather than falling back to a PIN or browser Owner claim.
export function createCanonicalStaffFactorApprovalPolicy({
  verifyStrongApprover,canApproveEnrollment,canRecoverFactor,now=()=>Date.now()
}={}) {
  if([verifyStrongApprover,canApproveEnrollment,canRecoverFactor,now]
       .some(fn=>typeof fn!=='function'))
    throw new TypeError('Strong independently verified manager and exact approval grants required.');
  return Object.freeze({
    verifyStrongApprover:async context=>{
      let manager;
      try{manager=await verifyStrongApprover(context);}catch{throw forbidden();}
      const id=String(manager?.id??''),instant=now();
      if(!Number.isSafeInteger(instant)||instant<0||manager?.active!==true||!ID.test(id)||
         !['passkey','security-key','oidc-mfa'].includes(manager.method)||
         !Number.isSafeInteger(manager.authenticatedAtMs)||
         manager.authenticatedAtMs>instant||
         manager.authenticatedAtMs<=instant-5*60_000)throw forbidden();
      return Object.freeze({
        id,active:true,method:manager.method,
        authenticatedAtMs:manager.authenticatedAtMs
      });
    },
    canApproveEnrollment:async data=>await canApproveEnrollment(data)===true,
    canRecoverFactor:async data=>await canRecoverFactor(data)===true
  });
}
