import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {createPostgresStaffPasskeys} from './staffPasskeysPostgres.js';
import {createCanonicalStaffFactorSession} from './primaryLiveTotpEnrollmentGate.js';

// UNMOUNTED, isolated-test ONLY candidate for operator-selected first Owner.
// The operator provisions approval row + independent random secret OUTSIDE app.
// This module never issues activation secrets or selects an employee from PIN.
// A signed employee session is necessary but NEVER sufficient.
const EMPLOYEE=/^[1-9][0-9]{0,17}$/;
const SECRET=/^[A-Za-z0-9_-]{43}$/; // 32 cryptographically random bytes, base64url
const denied=()=>Object.assign(new Error('First Owner activation denied.'),{
 status:403,code:'HC_FIRST_OWNER_ACTIVATION_DENIED'
});
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');

export function createOperatorFirstOwnerPasskeyCandidate({
 environment,enabled=false,expectedOwnerEmployeeId,staffAuthGateway,
 timeclockIdentity,pool,readActivationSecret,origin,rpID,signingSecret,
 loginThrottle,now=()=>Date.now(),webauthn,
 createPasskeys=createPostgresStaffPasskeys
}={}){
 const ownerId=String(expectedOwnerEmployeeId??'');
 if(environment!=='test'||enabled!==true||!EMPLOYEE.test(ownerId)||
    typeof pool?.connect!=='function'||
    typeof readActivationSecret!=='function'||typeof now!=='function'||
    typeof createPasskeys!=='function')
   throw new TypeError('An explicitly selected employee and test-only activation verifier are required.');
 const canonical=createCanonicalStaffFactorSession({
   staffAuthGateway,timeclockIdentity,now
 });
 async function verifiedRequest(context,employeeId){
   const person=await canonical.verifyBoundEmployee(context);
   if(String(person.id)!==ownerId||String(employeeId)!==ownerId)throw denied();
   let secret;
   try{secret=await readActivationSecret(context);}catch{throw denied();}
   if(typeof secret!=='string'||!SECRET.test(secret)||
      Buffer.from(secret,'base64url').length!==32)throw denied();
   return hash(secret);
 }
 async function pending(client,digest,lock=false){
   // Locking here serializes issuance/consumption across replicas.
   const r=await client.query(
    `SELECT employee_id,activation_digest,approved_at,expires_at,
       consumed_at,credential_id
      FROM hc_first_owner_activations WHERE employee_id=$1
      ${lock?'FOR UPDATE':''}`,[ownerId]);
   if(r.rowCount!==1)return false;
   const a=r.rows[0],t=now(),from=new Date(a.approved_at).getTime();
   const until=new Date(a.expires_at).getTime();
   if(String(a.employee_id)!==ownerId||a.consumed_at!==null||
      a.credential_id!==null||!Number.isSafeInteger(t)||
      !Number.isFinite(from)||!Number.isFinite(until)||
      from>t||until<=t||until>from+15*60_000||
      !/^[a-f0-9]{64}$/.test(String(a.activation_digest)))return false;
   return timingSafeEqual(Buffer.from(a.activation_digest,'hex'),Buffer.from(digest,'hex'));
 }
 async function authorizeRegistration({context,employeeId,phase}={}){
   if(!['begin','complete'].includes(phase))return false;
   let c;
   try{
     const digest=await verifiedRequest(context,employeeId);
     c=await pool.connect();
     const owners=await c.query("SELECT 1 FROM hc_admin_principals WHERE role='owner' LIMIT 1");
     if(owners.rowCount!==0)return false;
     return await pending(c,digest);
   }catch{return false;}finally{c?.release();}
 }
 async function commitRegistrationGrant({context,employeeId,credentialId,client}={}){
   if(typeof client?.query!=='function'||typeof credentialId!=='string'||
      credentialId.length<16||credentialId.length>1024)throw denied();
   const digest=await verifiedRequest(context,employeeId);
   // Advisory transaction lock is shared among first-Owner attempts, including
   // earlier commissioning candidates, when reviewed together for deployment.
   await client.query('SELECT pg_advisory_xact_lock(78619136,801)');
   const owners=await client.query("SELECT employee_id FROM hc_admin_principals WHERE role='owner'");
   if(owners.rowCount!==0||!(await pending(client,digest,true)))throw denied();
   const consumed=await client.query(
    `UPDATE hc_first_owner_activations SET consumed_at=now(),credential_id=$2
     WHERE employee_id=$1 AND consumed_at IS NULL AND expires_at>now()
     RETURNING employee_id`,[ownerId,credentialId]);
   if(consumed.rowCount!==1)throw denied();
   await client.query(
    "INSERT INTO hc_admin_principals(employee_id,role,active,appointed_by) VALUES($1,'owner',true,NULL)",
    [ownerId]);
   await client.query(
    `INSERT INTO hc_first_owner_activation_events
     (event_id,employee_id,credential_id,event_type)
     VALUES($1,$2,$3,'first_owner_passkey_activated')`,
    [randomUUID(),ownerId,credentialId]);
 }
 const passkeys=createPasskeys({
   pool,origin,rpID,signingSecret,loginThrottle,now,
   verifyBoundEmployee:canonical.verifyBoundEmployee,
   authorizeRegistration,commitRegistrationGrant,
   verifyStrongManager:async()=>{throw denied();},
   canManage:async()=>false,
   ...(webauthn?{webauthn}:{})
 });
 return Object.freeze({
   beginRegistration:passkeys.beginRegistration,
   finishRegistration:passkeys.finishRegistration,
   // Reuse the SAME verifier, credential store, signing key and canonical
   // employee session for subsequent actual WebAuthn step-up checks.
   beginAuthentication:passkeys.beginAuthentication,
   finishAuthentication:passkeys.finishAuthentication,
   verify:passkeys.verify
 });
}
