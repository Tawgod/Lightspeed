import express from 'express';
import {createTimeclockScannerIdentity} from '../scannerTimeclockIdentity.js';
import {createStaffAuthGateway} from '../staffAuthGateway.js';
import {createPostgresStaffLoginThrottle} from './staffLoginThrottle.js';
import {createPrimaryTimeclockVerificationWiring} from './primaryTimeclockVerificationWiring.js';

// DEVELOPMENT ONLY: no production mounting, credential migration, factor
// enrollment or Owner self-appointment. Reuses the existing Timeclock gateway,
// active-employee canonical reader, persistent throttle and signed session.
const ID=/^[1-9][0-9]{0,17}$/;
const OFF=[
 'HC_STAGING_TEST_LOGIN_ENABLED','HC_CORE_EMPLOYEE_PILOT_ENABLED',
 'HC_OWNER_STAGING_ENABLED','SPECIAL_ORDERS_LIVE_MODE',
 'SCANNER_ENABLED','SPECIAL_ORDERS_ALLOW_MIGRATION',
 'SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES','HC_ADMIN_NAV_ENABLED'
];
const ABSENT=[
 'DATABASE_URL','LIGHTSPEED_TOKEN','DISCORD_TOKEN',
 'HC_PILOT_OPERATOR_KEY','HC_STAGING_TEST_PIN_HASH',
 'HC_OWNER_STAGING_DATABASE_URL','HC_OWNER_TIMECLOCK_SERVICE_SECRET'
];
const SECRETS=[
 'HC_PRIMARY_TIMECLOCK_SERVICE_SECRET','HC_PRIMARY_SESSION_SECRET',
 'HC_PRIMARY_THROTTLE_SECRET'
];
const denied=()=>Object.assign(new Error('Canonical staff credential required.'),{status:403});
function validOrigin(value,{service=false}={}){
  if(typeof value!=='string')return false;
  let url;
  try{url=new URL(value);}catch{return false;}
  if(url.origin!==value||url.pathname!=='/'||url.username||url.password||
     url.search||url.hash)return false;
  return service
    ? url.protocol==='https:'||
      (url.protocol==='http:'&&url.hostname.endsWith('.railway.internal'))
    : url.protocol==='https:'&&url.hostname.endsWith('.up.railway.app');
}
export function validateCanonicalEmployeePreviewEnvironment(env={}){
  const issues=[];
  if(env.NODE_ENV!=='test'||env.HC_SECURITY_ENV!=='isolated-staging'||
     env.HC_PRIMARY_EMPLOYEE_DISCOVERY_ENABLED!=='true'||
     env.HC_PUBLIC_BASE_PATH!=='/HobbyCorner')
    issues.push('isolated_read_only_mode');
  if(OFF.some(k=>env[k]!=='false')||
     ABSENT.some(k=>String(env[k]||'').trim()))
    issues.push('live_or_synthetic_integration');
  if(!validOrigin(env.HC_PRIMARY_DISCOVERY_ORIGIN)||
     !validOrigin(env.HC_PRIMARY_TIMECLOCK_ORIGIN,{service:true})||
     env.HC_PRIMARY_DISCOVERY_ORIGIN===env.HC_PRIMARY_TIMECLOCK_ORIGIN)
    issues.push('isolated_https_and_timeclock_origins');
  if(SECRETS.some(k=>typeof env[k]!=='string'||
     Buffer.byteLength(env[k],'utf8')<32)||
     new Set(SECRETS.map(k=>env[k])).size!==SECRETS.length)
    issues.push('independent_server_only_secrets');
  return Object.freeze({ready:issues.length===0,issues:Object.freeze(issues)});
}
function strictCanonicalIdentity(timeclock){
  const check=person=>{
    const id=String(person?.id??'');
    // Scanner's role/canApprove flags are NEVER Owner assignment. Reject
    // synthetic pilot 901 even if an external adapter echoes that ID.
    if(!ID.test(id)||id==='901'||
       person.permissionSource!=='timeclock_employee'||person.canLookup!==true)
      throw denied();
    return person;
  };
  return Object.freeze({
    verifyPin:async pin=>check(await timeclock.verifyPin(pin)),
    authorize:async id=>{
      if(!ID.test(String(id))||String(id)==='901')throw denied();
      const person=check(await timeclock.authorize(id));
      if(String(person.id)!==String(id))throw denied();
      return person;
    }
  });
}
// The runtime role may update ONLY the durable login throttle. It cannot
// create schema, delete throttle rows or read/alter Owner/passkey tables.
export async function verifyCanonicalDiscoveryRuntimeRole(pool){
  if(typeof pool?.query!=='function')return false;
  try{
    const r=await pool.query(`SELECT
      has_schema_privilege(current_user,'public','CREATE') AS can_create,
      has_table_privilege(current_user,'public.hc_staff_auth_throttle',
        'SELECT,INSERT,UPDATE') AS can_throttle,
      has_table_privilege(current_user,'public.hc_staff_auth_throttle',
        'DELETE,TRUNCATE') AS can_delete_throttle,
      CASE WHEN to_regclass('public.hc_admin_principals') IS NULL THEN false
        ELSE has_table_privilege(current_user,'public.hc_admin_principals',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') END AS can_admin,
      CASE WHEN to_regclass('public.hc_staff_passkeys') IS NULL THEN false
        ELSE has_table_privilege(current_user,'public.hc_staff_passkeys',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') END AS can_passkeys`);
    const row=r.rows?.[0];
    return r.rowCount===1&&row.can_create===false&&row.can_throttle===true&&
      row.can_delete_throttle===false&&row.can_admin===false&&
      row.can_passkeys===false;
  }catch{return false;}
}
export async function createCanonicalEmployeeDiscoveryApp({
  environment=process.env,pool,checkOwnerAssignment,
  fetchImpl,now=()=>Date.now()
}={}){
  const report=validateCanonicalEmployeePreviewEnvironment(environment);
  if(!report.ready)throw new TypeError('Discovery preflight refused: '+report.issues.join(', '));
  if(typeof pool?.connect!=='function'||
     typeof checkOwnerAssignment!=='function'||typeof now!=='function'||
     (fetchImpl!==undefined&&typeof fetchImpl!=='function')||
     !(await verifyCanonicalDiscoveryRuntimeRole(pool)))
    throw new TypeError('Independent Owner reader and restricted throttle role required.');
  const rawTimeclock=createTimeclockScannerIdentity({
    baseUrl:environment.HC_PRIMARY_TIMECLOCK_ORIGIN,
    serviceSecret:environment.HC_PRIMARY_TIMECLOCK_SERVICE_SECRET,
    mode:'scanner',...(fetchImpl?{fetchImpl}:{})
  });
  const identity=strictCanonicalIdentity(rawTimeclock);
  const throttle=createPostgresStaffLoginThrottle({
    pool,secret:environment.HC_PRIMARY_THROTTLE_SECRET,
    scope:'hc:primary:employee:discovery'
  });
  const staffAuth=createStaffAuthGateway({
    identity,sessionSecret:environment.HC_PRIMARY_SESSION_SECRET,
    requireEmployeeSelector:true,
    loginLimiter:({employeeId,ip})=>throttle.reserve({employeeId,sourceIp:ip}),
    clock:now
  });
  const wiring=createPrimaryTimeclockVerificationWiring({
    environment:'test',enabled:true,staffAuth,timeclockIdentity:identity,
    checkOwnerAssignment,now
  });
  const app=express();
  app.disable('x-powered-by');
  // Until approved proxy-hop review, never trust browser X-Forwarded-For.
  app.set('trust proxy',false);
  app.use((_req,res,next)=>{
    res.set({'Cache-Control':'no-store, max-age=0',
      'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",
      'X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
      'X-Content-Type-Options':'nosniff'});
    next();
  });
  app.get('/health',(_req,res)=>res.json({
    service:'hc-canonical-employee-identity-preview',
    ready:true,readOnly:true,realEmployeeGrants:false
  }));
  app.use('/HobbyCorner/api/staff-auth',(req,res,next)=>{
    if(req.method==='POST' &&
       (req.get('origin')!==environment.HC_PRIMARY_DISCOVERY_ORIGIN||
        (req.get('sec-fetch-site')&&req.get('sec-fetch-site')!=='same-origin')))
      return res.status(403).json({error:'Same-origin sign-in required.'});
    next();
  },staffAuth.router);
  app.use('/HobbyCorner/api/primary',wiring.router);
  app.use((_req,res)=>res.status(404).json({
    error:'No business tools or employee enrollment are mounted.'
  }));
  return Object.freeze({app});
}
