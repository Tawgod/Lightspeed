// Backend-only adapter to the existing canonical Timeclock -> Scanner bridge.
// No new employee table, credential copy, Owner role inference, or browser API.
// Construct ONLY with the server-side createTimeclockScannerIdentity() client;
// never inject the synthetic test identity into a production commissioning flow.
const ID=/^[1-9][0-9]{0,17}$/;
const denied=()=>Object.assign(new Error('Canonical Timeclock employee unavailable.'),{
  status:403,code:'HC_CANONICAL_EMPLOYEE_DENIED'
});
const unavailable=()=>Object.assign(new Error('Canonical Timeclock service unavailable.'),{
  status:503,code:'HC_CANONICAL_EMPLOYEE_UNAVAILABLE'
});

export function createPrimaryTimeclockCanonicalReader({timeclockIdentity}={}) {
  if(typeof timeclockIdentity?.authorize!=='function')
    throw new TypeError('Trusted Timeclock service identity adapter required.');
  async function verifyCanonicalTimeclockEmployee({employeeId}={}) {
    const id=String(employeeId??'');
    if(!ID.test(id))throw denied();
    let employee;
    try{employee=await timeclockIdentity.authorize(id);}
    catch(error){
      if(error?.status===401||error?.status===403)throw denied();
      throw unavailable();
    }
    // Existing /integrations/scanner/authorize queries Timeclock's
    // employees table WHERE id=$1 AND active=TRUE (no clock-in check).
    // scannerEffectivePermissions marks this as timeclock_employee;
    // role/canApprove are deliberately NOT owner/admin authorization.
    if(String(employee?.id??'')!==id||
       employee.permissionSource!=='timeclock_employee'||
       employee.canLookup!==true)throw denied();
    return Object.freeze({source:'timeclock',employeeId:id,active:true});
  }
  return Object.freeze({verifyCanonicalTimeclockEmployee});
}
