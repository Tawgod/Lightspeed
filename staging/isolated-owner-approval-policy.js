// Test-only operation permission adapter for the SINGLE synthetic test Owner.
// It never authorizes production employees, passkey recovery, factor resets,
// or role-based actions. It must be combined with a *real* verified WebAuthn
// proof from the existing passkey service; PIN/Discord owner IDs are not proof.
const EMPLOYEE='901';
const OWNER='115626919134887940';
const GUILD='1485804234753573066';
const ORIGIN='https://staff-security-staging-test.up.railway.app';
const WINDOW_MS=5*60_000;

export function createIsolatedOwnerApprovalPolicy({
  environment=process.env,verifyOwnerPasskey,now=()=>Date.now()
}={}){
  if(environment.NODE_ENV!=='test'||
     environment.HC_SECURITY_ENV!=='isolated-staging'||
     environment.HC_STAGING_TEST_OWNER_DISCORD_ID!==OWNER||
     environment.HC_STAGING_TEST_GUILD_ID!==GUILD||
     environment.HC_STAGING_PUBLIC_ORIGIN!==ORIGIN||
     environment.HC_STAGING_PIN_STORE_MODE!=='database'||
     environment.HC_STAGING_PIN_SETUP_ENABLED!=='false'||
     environment.HC_STAGING_OWNER_PASSKEY_ENABLED!=='true'||
     environment.HC_STAGING_OWNER_APPROVAL_ENABLED!=='true'||
     typeof verifyOwnerPasskey!=='function'||typeof now!=='function')
    throw new TypeError('Isolated Owner manager approval requires a real verified test passkey.');
  async function canApproveEnrollment({
    context,approverId,employeeId,operation
  }={}){
    // This is an intentional staging-only self-enrollment test exception.
    // Production may require a separate manager and always retains its own
    // role/permission system.
    if(String(approverId)!==EMPLOYEE||
       String(employeeId)!==EMPLOYEE||
       operation!=='staff.authenticator.enroll'||
       typeof context?.get!=='function'||
       context.get('origin')!==ORIGIN||
       context.get('sec-fetch-site')==='cross-site')return false;
    let proof;
    try{proof=await verifyOwnerPasskey(context);}catch{return false;}
    const t=now();
    return !!(Number.isSafeInteger(t)&&t>0&&
      proof?.verified===true&&proof.method==='passkey'&&
      proof.active===true&&
      String(proof.employeeId)===EMPLOYEE&&
      String(proof.id)===EMPLOYEE&&
      Number.isSafeInteger(proof.authenticatedAtMs)&&
      proof.authenticatedAtMs<=t&&
      proof.authenticatedAtMs>t-WINDOW_MS);
  }
  async function canRecoverFactor(){return false;}
  async function canResetFactor(){return false;}
  return Object.freeze({canApproveEnrollment,canRecoverFactor,canResetFactor});
}
