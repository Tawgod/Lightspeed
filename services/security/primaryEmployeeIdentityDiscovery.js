// DEVELOPMENT ONLY. Read-only prerequisite to first primary account factor enrollment.
// This is not an enrollment grant, an Owner bootstrap, or an authentication route.
// Only an already signed Timeclock employee session can identify the candidate;
// the canonical record must be independently resolved by a backend-owned adapter.
const ID=/^[1-9][0-9]{0,17}$/;
const BINDING=/^[A-Za-z0-9_.:-]{16,256}$/;
const invalid=()=>Object.assign(new Error('Employee identity verification required.'),{
  status:403,code:'HC_PRIMARY_IDENTITY_DENIED'
});
const unavailable=()=>Object.assign(new Error('Primary employee identity service unavailable.'),{
  status:503,code:'HC_PRIMARY_IDENTITY_UNAVAILABLE'
});

export function createPrimaryEmployeeIdentityDiscovery({
  verifyBoundEmployee, verifyCanonicalTimeclockEmployee,
  checkOwnerAssignment, now=()=>Date.now()
}={}) {
  if([verifyBoundEmployee,verifyCanonicalTimeclockEmployee,
      checkOwnerAssignment,now].some(f=>typeof f!=='function'))
    throw new TypeError('Signed staff session, authoritative Timeclock record and Owner grant lookup required.');

  async function inspectIdentity({context}={}) {
    if(!context)throw invalid();
    const instant=now();
    if(!Number.isSafeInteger(instant)||instant<0)throw invalid();
    let session;
    try{session=await verifyBoundEmployee(context);}catch{throw invalid();}
    const employeeId=String(session?.id??'');
    if(!ID.test(employeeId)||session?.active!==true||
       String(session.employeeId??session.id)!==employeeId||
       !BINDING.test(session.binding)||!Number.isSafeInteger(session.expiresAtMs)||
       session.expiresAtMs<=instant)throw invalid();

    // A synthetic staging employee record, browser-provided employee ID,
    // Discord role, or copied test factor must never become a real principal.
    let canonical;
    try{canonical=await verifyCanonicalTimeclockEmployee({employeeId});}
    catch{throw unavailable();}
    if(canonical?.source!=='timeclock'||
       String(canonical.employeeId??canonical.id??'')!==employeeId||
       canonical.active!==true)throw invalid();

    // An Owner role must already be independently recorded by an authorized
    // admin commissioning process. A missing appointment is NOT permission to
    // bootstrap it from PIN, Discord identity, or the test account.
    let ownerAssigned=false;
    try{
      const assigned=await checkOwnerAssignment({employeeId});
      if(typeof assigned!=='boolean')throw unavailable();
      ownerAssigned=assigned;
    }catch{throw unavailable();}

    return Object.freeze({
      employeeId,
      currentEmployee:true,
      canonicalTimeclockIdentityVerified:true,
      independentlyAppointedOwner:ownerAssigned,
      nextGate:ownerAssigned?'independent-primary-factor-verification':'independent-owner-commissioning',
      primaryFactorEnrolled: 'not_checked',
      enrollmentAuthorized:false,
      readOnly:true,
      syntheticFactorTransferAllowed:false
    });
  }
  return Object.freeze({inspectIdentity});
}
