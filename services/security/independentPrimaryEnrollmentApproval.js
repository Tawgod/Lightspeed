// DEVELOPMENT CANDIDATE — independently commissioned approver boundary.
// Never used for isolated synthetic test employee 901 and never self-approves.
// An existing durable enrollment approval still performs the final transaction,
// fresh WebAuthn/IdP proof check and exact operation authorization.
const ID=/^[1-9][0-9]{0,17}$/;
const STRONG=new Set(['passkey','security-key','oidc-mfa']);
const forbidden=()=>Object.assign(new Error('Independent enrollment approver required.'),{
  status:403,code:'HC_PRIMARY_APPROVER_DENIED'
});
const unavailable=()=>Object.assign(new Error('Approver readiness unavailable.'),{
  status:503,code:'HC_PRIMARY_APPROVER_UNAVAILABLE'
});

export function createIndependentPrimaryEnrollmentApproval({
  verifyCanonicalTimeclockEmployee,canApproveEnrollment,
  verifyStrongApprover,now=()=>Date.now()
}={}) {
  if([verifyCanonicalTimeclockEmployee,canApproveEnrollment,verifyStrongApprover,now]
      .some(f=>typeof f!=='function'))
    throw new TypeError('Trusted independent approver and exact grants required.');

  async function verifyApprover(context) {
    let proof;
    try{proof=await verifyStrongApprover(context);}catch{throw forbidden();}
    const t=now(),id=String(proof?.id??'');
    if(!Number.isSafeInteger(t)||t<0||
       proof?.active!==true||!ID.test(id)||!STRONG.has(proof.method)||
       !Number.isSafeInteger(proof.authenticatedAtMs)||
       proof.authenticatedAtMs>t||proof.authenticatedAtMs<=t-5*60_000)
      throw forbidden();
    let employee;
    try{employee=await verifyCanonicalTimeclockEmployee({employeeId:id});}
    catch{throw forbidden();}
    if(employee?.source!=='timeclock'||employee?.active!==true||
       String(employee.employeeId)!==id)throw forbidden();
    return Object.freeze({id,active:true,method:proof.method,authenticatedAtMs:proof.authenticatedAtMs});
  }

  // Called by the durable staffFactorApprovals.canApprove adapter.
  // A valid PIN, test owner role or ability to approve Scanner actions
  // never qualifies; separate backend grant required for the *other* actor.
  async function canApprove({context,approverId,employeeId,operation}={}) {
    const target=String(employeeId??''),actor=String(approverId??'');
    if(!ID.test(target)||!ID.test(actor)||actor===target||
       operation!=='staff.authenticator.enroll')return false;
    let principal;
    try{principal=await verifyApprover(context);}catch{return false;}
    if(principal.id!==actor)return false;
    let targetPerson;
    try{targetPerson=await verifyCanonicalTimeclockEmployee({employeeId:target});}
    catch{return false;}
    if(targetPerson?.active!==true||targetPerson?.source!=='timeclock'||
       String(targetPerson.employeeId)!==target)return false;
    try{return await canApproveEnrollment({
      context,approverId:actor,employeeId:target,operation
    })===true;}catch{return false;}
  }

  // Readiness does not grant permission or expose a staff roster. A trusted
  // internal adapter may supply whether a separately enrolled/authorized
  // approver exists. No enrollment writes are performed.
  async function preflight({context,verifySignedTarget,hasIndependentApprover}={}) {
    if(typeof verifySignedTarget!=='function'||
       typeof hasIndependentApprover!=='function')throw new TypeError('Trusted preflight adapters required.');
    let employee;
    try{employee=await verifySignedTarget(context);}catch{throw forbidden();}
    const id=String(employee?.id??''),t=now();
    if(!ID.test(id)||employee?.active!==true||
       !Number.isSafeInteger(employee.expiresAtMs)||employee.expiresAtMs<=t||
       typeof employee.binding!=='string'||employee.binding.length<16)throw forbidden();
    let canonical;
    try{canonical=await verifyCanonicalTimeclockEmployee({employeeId:id});}
    catch{throw forbidden();}
    if(canonical?.active!==true||canonical.source!=='timeclock'||
       String(canonical.employeeId)!==id)throw forbidden();
    let available;
    try{available=await hasIndependentApprover({employeeId:id});}
    catch{throw unavailable();}
    if(typeof available!=='boolean')throw unavailable();
    return Object.freeze({
      employeeId:id,canonicalIdentityVerified:true,
      independentApproverAvailable:available,
      nextGate:available?'approved-enrollment-request':'independent-owner-commissioning',
      enrollmentAuthorized:false,readOnly:true
    });
  }
  return Object.freeze({verifyApprover,canApprove,preflight});
}
