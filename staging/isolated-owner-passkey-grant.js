import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';

// A staging-only independent first-owner bootstrap. A real employee/manager
// deployment must use its own organization-verified identity procedure.
// The 256-bit private bootstrap key is provisioned outside the PIN service;
// neither a Discord owner claim nor a four-digit PIN can replace it.
const OWNER='115626919134887940';
const GUILD='1485804234753573066';
const EMPLOYEE='901';
const PUBLIC_ORIGIN='https://staff-security-staging-test.up.railway.app';
const denial=()=>Object.assign(new Error('Independent owner bootstrap required.'),{
  code:'HC_PASSKEY_DENIED',status:403
});
function constantTimeKey(actual,expected){
 if(typeof actual!=='string'||typeof expected!=='string'||
    actual.length<43||actual.length>256||actual.length!==expected.length)return false;
 const hash=s=>createHash('sha256').update(s,'utf8').digest();
 return timingSafeEqual(hash(actual),hash(expected));
}
export function createIsolatedFirstOwnerPasskeyGrant({
 environment=process.env,pool,verifyBoundEmployee,now=()=>Date.now()
}={}){
 if(environment.NODE_ENV!=='test'||
    environment.HC_SECURITY_ENV!=='isolated-staging'||
    environment.HC_STAGING_TEST_OWNER_DISCORD_ID!==OWNER||
    environment.HC_STAGING_TEST_GUILD_ID!==GUILD||
    environment.HC_STAGING_TEST_LOGIN_ENABLED!=='true'||
    environment.HC_STAGING_PIN_STORE_MODE!=='database'||
    environment.HC_STAGING_PIN_SETUP_ENABLED!=='false'||
    environment.HC_STAGING_OWNER_PASSKEY_ENABLED!=='true'||
    environment.HC_STAGING_PUBLIC_ORIGIN!==PUBLIC_ORIGIN||
    !/^[A-Za-z0-9_-]{43,256}$/.test(environment.HC_STAGING_OWNER_BOOTSTRAP_KEY||'')||
    typeof pool?.query!=='function'||typeof verifyBoundEmployee!=='function'||
    typeof now!=='function')
   throw new TypeError('Isolated Owner passkey bootstrap prerequisites are not met.');
 const key=environment.HC_STAGING_OWNER_BOOTSTRAP_KEY;
 const validTime=()=>{const t=now();if(!Number.isSafeInteger(t)||t<=0)throw denial();return t;};
 async function trustedOwner(context){
   if(typeof context?.get!=='function'||
      context.get('origin')!==PUBLIC_ORIGIN||
      context.get('sec-fetch-site')==='cross-site'||
      !constantTimeKey(context.get('x-hc-owner-bootstrap-key'),key))
     throw denial();
   let subject;
   try{subject=await verifyBoundEmployee(context);}catch{throw denial();}
   if(String(subject?.id||subject?.employeeId)!==EMPLOYEE||
      subject?.active!==true||
      typeof subject?.binding!=='string'||subject.binding.length<16||
      !Number.isSafeInteger(subject.expiresAtMs)||subject.expiresAtMs<=validTime())
     throw denial();
   return subject;
 }
 async function authorizeRegistration({context,employeeId,phase}={}){
   if(!['begin','complete'].includes(phase)||String(employeeId)!==EMPLOYEE)
     throw denial();
   await trustedOwner(context);
   try{
     const state=await pool.query(
       'SELECT consumed_at,expires_at FROM hc_staging_owner_passkey_bootstrap WHERE id=1'
     );
     const row=state.rows?.[0];
     if(!row||row.consumed_at||new Date(row.expires_at).getTime()<=validTime())
       throw denial();
     const existing=await pool.query(
       'SELECT 1 FROM hc_staff_passkeys WHERE employee_id=$1 AND revoked_at IS NULL LIMIT 1',
       [EMPLOYEE]
     );
     if(existing.rowCount!==0)throw denial();
     return true;
   }catch{throw denial();}
 }
 // Invoked by the existing passkey service only after WebAuthn registration
 // attestation has been verified and both credential/audit inserts are pending.
 // The transaction lock makes racing first-passkey ceremonies one-use.
 async function commitRegistrationGrant({context,employeeId,credentialId,client}={}){
   if(String(employeeId)!==EMPLOYEE||
      typeof credentialId!=='string'||!credentialId||
      typeof client?.query!=='function')throw denial();
   await trustedOwner(context);
   const state=await client.query(
     'SELECT consumed_at,expires_at FROM hc_staging_owner_passkey_bootstrap WHERE id=1 FOR UPDATE'
   );
   const row=state.rows?.[0];
   if(!row||row.consumed_at||new Date(row.expires_at).getTime()<=validTime())
     throw denial();
   const others=await client.query(
     'SELECT 1 FROM hc_staff_passkeys WHERE employee_id=$1 AND credential_id<>$2 AND revoked_at IS NULL LIMIT 1',
     [EMPLOYEE,credentialId]
   );
   if(others.rowCount!==0)throw denial();
   const updated=await client.query(
     'UPDATE hc_staging_owner_passkey_bootstrap SET consumed_at=now(),credential_id=$1 WHERE id=1 AND consumed_at IS NULL RETURNING id',
     [credentialId]
   );
   if(updated.rowCount!==1)throw denial();
   await client.query(
     'INSERT INTO hc_staging_owner_passkey_bootstrap_events(event_id,employee_id,credential_id,kind) VALUES($1,$2,$3,$4)',
     [randomUUID(),EMPLOYEE,credentialId,'completed']
   );
 }
 return Object.freeze({authorizeRegistration,commitRegistrationGrant});
}
