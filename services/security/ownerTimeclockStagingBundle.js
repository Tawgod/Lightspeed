import {createTimeclockScannerIdentity} from '../scannerTimeclockIdentity.js';
import {createStaffAuthGateway} from '../staffAuthGateway.js';
import {createPostgresStaffLoginThrottle} from './staffLoginThrottle.js';
import {createOwnerSecurityStagingMount} from './ownerSecurityStagingMount.js';

// Configuration-only staging assembly. Construction makes no external calls,
// does not apply migrations, does not provision Owner, and does not deploy.
// The operator must configure an approved, canonical Timeclock service URL,
// not an identity returned by the browser or existing synthetic staging.
const ID=/^[1-9][0-9]{0,17}$/;
const b64=/^[A-Za-z0-9+/]{43}=$/;
const secret=(e,k)=>typeof e[k]==='string'&&Buffer.byteLength(e[k])>=32;
export function validateOwnerTimeclockStagingConfig(e={}){
 const missing=[];
 if(e.NODE_ENV!=='test'||e.HC_SECURITY_ENV!=='isolated-staging'||
    e.HC_OWNER_STAGING_ENABLED!=='true')missing.push('isolated_staging_mode');
 if(!ID.test(String(e.HC_OWNER_TIMECLOCK_EMPLOYEE_ID??''))||
    String(e.HC_OWNER_TIMECLOCK_EMPLOYEE_ID)==='901')
   missing.push('canonical_owner_employee_id');
 let origin;
 try{
  origin=new URL(e.HC_OWNER_STAGING_ORIGIN);
  if(origin.protocol!=='https:'||origin.origin!==e.HC_OWNER_STAGING_ORIGIN||
     origin.pathname!=='/'||origin.username||origin.password||origin.hash||
     origin.search||origin.hostname!==e.HC_OWNER_STAGING_RPID)
    missing.push('owner_https_origin_rpid');
 }catch{missing.push('owner_https_origin_rpid');}
 let clock;
 try{
  clock=new URL(e.HC_OWNER_TIMECLOCK_ORIGIN);
  if(clock.origin!==e.HC_OWNER_TIMECLOCK_ORIGIN||
     clock.pathname!=='/'||clock.username||clock.password||
     clock.search||clock.hash||
     !(clock.protocol==='https:'||
      (clock.protocol==='http:'&&clock.hostname.endsWith('.railway.internal'))))
    missing.push('approved_private_timeclock_origin');
 }catch{missing.push('approved_private_timeclock_origin');}
 const keys=['HC_OWNER_TIMECLOCK_SERVICE_SECRET','HC_OWNER_SESSION_SECRET',
  'HC_OWNER_THROTTLE_SECRET','HC_OWNER_PASSKEY_SIGNING_SECRET',
  'HC_OWNER_APPROVAL_HMAC_SECRET','HC_OWNER_MFA_SESSION_SECRET'];
 for(const key of keys)if(!secret(e,key))missing.push(key);
 if(typeof e.HC_OWNER_TOTP_ENCRYPTION_KEY!=='string'||
    !b64.test(e.HC_OWNER_TOTP_ENCRYPTION_KEY)||
    Buffer.from(e.HC_OWNER_TOTP_ENCRYPTION_KEY,'base64').length!==32)
   missing.push('HC_OWNER_TOTP_ENCRYPTION_KEY');
 const values=keys.filter(k=>secret(e,k)).map(k=>e[k]);
 if(values.length!==new Set(values).size)missing.push('independent_security_secrets');
 // This service must never accidentally point to the synthetic test account.
 if(e.HC_STAGING_TEST_LOGIN_ENABLED==='true'||
    e.HC_STAGING_PIN_SETUP_ENABLED==='true')
  missing.push('synthetic_login_disabled');
 return Object.freeze({ready:missing.length===0,issues:Object.freeze(missing)});
}
export function createOwnerTimeclockStagingBundle({
 environment, pool, fetchImpl,
 createIdentity=createTimeclockScannerIdentity,
 createAuth=createStaffAuthGateway,
 createThrottle=createPostgresStaffLoginThrottle,
 createMount=createOwnerSecurityStagingMount
}={}){
 const result=validateOwnerTimeclockStagingConfig(environment);
 if(!result.ready)throw new TypeError('Owner staging prerequisites failed: '+result.issues.join(', '));
 if(typeof pool?.connect!=='function'||
    typeof createIdentity!=='function'||typeof createAuth!=='function'||
    typeof createThrottle!=='function'||typeof createMount!=='function')
  throw new TypeError('Independent staging database and adapters are required.');
 const e=environment,ownerId=String(e.HC_OWNER_TIMECLOCK_EMPLOYEE_ID);
 const timeclockIdentity=createIdentity({
  baseUrl:e.HC_OWNER_TIMECLOCK_ORIGIN,
  serviceSecret:e.HC_OWNER_TIMECLOCK_SERVICE_SECRET,
  ...(fetchImpl?{fetchImpl}:{})
 });
 // The Scanner identity service can recognize many Timeclock employees,
 // but the initial Owner staging host must accept ONLY the exact operator
 // selected employee. Restrict both PIN issuance and later authorization.
 const selectedIdentity=Object.freeze({
  verifyPin:async pin=>{
   const person=await timeclockIdentity.verifyPin(pin);
   if(String(person?.id)!==ownerId||
      person?.permissionSource!=='timeclock_employee'||
      person?.canLookup!==true)
    throw Object.assign(new Error('Employee sign-in denied.'),{status:403});
   return person;
  },
  authorize:async id=>{
   if(String(id)!==ownerId)
    throw Object.assign(new Error('Employee access denied.'),{status:403});
   const person=await timeclockIdentity.authorize(id);
   if(String(person?.id)!==ownerId||
      person?.permissionSource!=='timeclock_employee'||
      person?.canLookup!==true)
    throw Object.assign(new Error('Employee access denied.'),{status:403});
   return person;
  }
 });
 const throttle=createThrottle({
  pool,secret:e.HC_OWNER_THROTTLE_SECRET,scope:'hc:owner:timeclock:pin'
 });
 const staffAuthGateway=createAuth({
  identity:selectedIdentity,sessionSecret:e.HC_OWNER_SESSION_SECRET,
  ttlSeconds:900,
  // This is a private, preselected account; the selector is NEVER proof.
  loginLimiter:({ip})=>throttle.reserve({employeeId:ownerId,sourceIp:ip})
 });
 const passkeyThrottle=createThrottle({
  pool,secret:e.HC_OWNER_THROTTLE_SECRET,scope:'hc:owner:passkey'
 });
 const stage=createMount({
  environment:'test',enabled:true,expectedOwnerEmployeeId:ownerId,
  loginRouter:staffAuthGateway.router,
  staffAuthGateway,timeclockIdentity:selectedIdentity,pool,
  origin:e.HC_OWNER_STAGING_ORIGIN,rpID:e.HC_OWNER_STAGING_RPID,
  signingSecret:e.HC_OWNER_PASSKEY_SIGNING_SECRET,
  loginThrottle:passkeyThrottle,
  totpEncryptionKey:e.HC_OWNER_TOTP_ENCRYPTION_KEY,
  throttleHmacSecret:e.HC_OWNER_THROTTLE_SECRET,
  approvalHmacSecret:e.HC_OWNER_APPROVAL_HMAC_SECRET,
  mfaSessionSecret:e.HC_OWNER_MFA_SESSION_SECRET
 });
 return Object.freeze({mount:stage.mount});
}
