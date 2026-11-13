import express from 'express';
import pg from 'pg';
import {fileURLToPath} from 'node:url';
import {createStaffAuthGateway} from '../services/staffAuthGateway.js';
import {createIsolatedTestIdentity} from './isolated-test-identity.js';
import {createPostgresStaffLoginThrottle}
  from '../services/security/staffLoginThrottle.js';
import {createPostgresStaffWorkstations}
  from '../services/security/staffWorkstationsPostgres.js';
import {createStaffStationProofRouter} from '../routes/staffStationProof.js';
import {createCoreEmployeePilotGrantReader}
  from '../services/security/coreEmployeePilotGrantReader.js';
import {createIsolatedCoreEmployeeReadPilot}
  from '../services/security/coreOperationsIsolatedReadPilot.js';
import {createIsolatedPilotOperator}
  from './isolated-employee-pilot-operator.js';

// SEPARATE isolated employee security preview, never imported by server.js.
// Runtime credentials are AUTH (limited to throttle/station tables) and
// READ (SELECT-only on the pilot grant table). No Postgres admin URL.
const PROJECT='c528d08e-b835-4b72-95f2-8a05090a2195';
const SECRET=/^[A-Za-z0-9_-]{43,128}$/;
const PIN_HASH=/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/;
const MUST_BE_OFF=[
  'SPECIAL_ORDERS_LIVE_MODE','SPECIAL_ORDERS_ALLOW_MIGRATION',
  'SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES','SCANNER_ENABLED',
  'SCANNER_TEST_CREATION_ENABLED','HC_ADMIN_NAV_ENABLED'
];
const MUST_BE_EMPTY=[
  'DATABASE_URL','LIGHTSPEED_DOMAIN','LIGHTSPEED_TOKEN','DISCORD_TOKEN',
  'SPECIAL_ORDERS_ADMIN_KEY','HC_OWNER_STAGING_DATABASE_URL',
  'HC_OWNER_TIMECLOCK_SERVICE_SECRET'
];

export function assertIsolatedEmployeePilotRuntime(env){
  if(env.NODE_ENV!=='test'||env.HC_SECURITY_ENV!=='isolated-staging'||
     env.HC_PILOT_PROJECT_ID!==PROJECT||
     env.HC_CORE_EMPLOYEE_PILOT_ENABLED!=='true'||
     env.HC_PILOT_BOOTSTRAP_ENABLED!=='false'||
     env.HC_STAGING_TEST_LOGIN_ENABLED!=='true'||
     env.HC_PUBLIC_BASE_PATH!=='/HobbyCorner'||
     env.HC_CORE_SECURITY_STAGING_ENABLED==='true'||
     MUST_BE_OFF.some(name=>env[name]!=='false')||
     MUST_BE_EMPTY.some(name=>String(env[name]||'').trim())){
     throw new Error('Refusing pilot runtime with live credentials, setup access or wrong environment.');
  }
  if(env.HC_STAGING_TEST_OWNER_DISCORD_ID!=='115626919134887940'||
     env.HC_STAGING_TEST_GUILD_ID!=='1485804234753573066'||
     !PIN_HASH.test(String(env.HC_STAGING_TEST_PIN_HASH||'')))
    throw new Error('Missing synthetic-only test employee configuration.');
  const fields=[
    'HC_PILOT_AUTH_PASSWORD','HC_PILOT_READ_PASSWORD',
    'HC_STAGING_SESSION_SECRET','HC_STAGING_THROTTLE_SECRET',
    'HC_PILOT_STATION_SIGNING_SECRET','HC_PILOT_OPERATOR_KEY'
  ];
  if(fields.some(name=>!SECRET.test(String(env[name]||'')))||
     new Set(fields.map(name=>env[name])).size!==fields.length)
    throw new Error('Missing independent high-entropy pilot-only secrets.');
  if(!/^[a-z0-9.-]+\.railway\.internal$/.test(String(env.HC_PILOT_DB_HOST||''))||
     env.HC_PILOT_DB_NAME!=='railway')
    throw new Error('Pilot requires its isolated Railway-private database hostname.');
  let origin;
  try{origin=new URL(env.HC_PILOT_PUBLIC_ORIGIN);}catch{}
  if(!origin||origin.protocol!=='https:'||
     !origin.hostname.endsWith('.up.railway.app')||
     origin.pathname!=='/'||origin.search||origin.hash||
     origin.origin!==env.HC_PILOT_PUBLIC_ORIGIN)
     throw new Error('Pilot requires a single exact HTTPS test origin.');
}
function runtimePool(env,kind){
  return new pg.Pool({
    host:env.HC_PILOT_DB_HOST,port:5432,database:env.HC_PILOT_DB_NAME,
    user:kind==='auth'?'hc_pilot_auth_runtime':'hc_pilot_grants_reader',
    password:kind==='auth'?env.HC_PILOT_AUTH_PASSWORD:env.HC_PILOT_READ_PASSWORD,
    max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:10000
  });
}
async function assertAuthPoolPrivileges(pool){
  try {
    const result=await pool.query(`SELECT
      current_user='hc_pilot_auth_runtime' AS correct_role,
      has_schema_privilege(current_user,'public','CREATE') AS can_create,
      has_table_privilege(current_user,'public.hc_staff_auth_throttle',
        'SELECT,INSERT,UPDATE') AS throttle,
      has_table_privilege(current_user,'public.hc_staff_stations',
        'SELECT,INSERT,UPDATE') AS stations,
      has_table_privilege(current_user,'public.hc_staff_station_challenges',
        'SELECT,INSERT,UPDATE') AS challenges,
      has_table_privilege(current_user,'public.hc_pilot_device_registration',
        'SELECT,UPDATE') AS registration,
      has_table_privilege(current_user,'public.hc_core_employee_pilot_grants',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS grant_access`);
    const r=result.rows?.[0];
    return result.rowCount===1&&r.correct_role===true&&
      r.can_create===false&&r.throttle===true&&r.stations===true&&
      r.challenges===true&&r.registration===true&&r.grant_access===false;
  }catch{return false;}
}
const headers=(_req,res,next)=>{
  res.set({
    'Cache-Control':'no-store, max-age=0',
    'Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
  });
  next();
};

export async function createIsolatedEmployeePilotApp({
  environment=process.env,authPool,readerPool
}={}){
  assertIsolatedEmployeePilotRuntime(environment);
  if(typeof authPool?.connect!=='function'||
     typeof readerPool?.query!=='function')throw new TypeError('Two isolated runtime database principals are required.');
  const reader=createCoreEmployeePilotGrantReader({pool:readerPool});
  if(!(await assertAuthPoolPrivileges(authPool))||!(await reader.verifyReadOnly()))
    throw new Error('Pilot refuses missing or elevated runtime database privileges.');
  const identity=createIsolatedTestIdentity({environment});
  const loginThrottle=createPostgresStaffLoginThrottle({
    pool:authPool,secret:environment.HC_STAGING_THROTTLE_SECRET,
    scope:'hc:employee-pilot:login'
  });
  const gateway=createStaffAuthGateway({
    identity,sessionSecret:environment.HC_STAGING_SESSION_SECRET,
    loginLimiter:({ip})=>loginThrottle.reserve({employeeId:'901',sourceIp:ip})
  });
  const stationThrottle=createPostgresStaffLoginThrottle({
    pool:authPool,secret:environment.HC_STAGING_THROTTLE_SECRET,
    scope:'hc:employee-pilot:station'
  });
  const stations=createPostgresStaffWorkstations({
    pool:authPool,
    signingSecret:environment.HC_PILOT_STATION_SIGNING_SECRET,
    verifyEmployeeSession:req=>gateway.verifyBoundEmployee(req),
    loginThrottle:stationThrottle,
    // No real Owner/passkey is provisioned. Standard manager enrollment and
    // revocation remain CLOSED; the separate one-use synthetic operator is
    // only available on this disposable test-only deployment.
    verifyStrongManager:async()=>null,canManage:async()=>false
  });
  const pilot=await createIsolatedCoreEmployeeReadPilot({
    environment,staffAuthGateway:gateway,workstations:stations,grantReader:reader
  });
  const operator=createIsolatedPilotOperator({
    pool:authPool,staffAuthGateway:gateway,operatorKey:environment.HC_PILOT_OPERATOR_KEY,
    loginThrottle:createPostgresStaffLoginThrottle({
      pool:authPool,secret:environment.HC_STAGING_THROTTLE_SECRET,
      scope:'hc:employee-pilot:operator'
    })
  });
  const app=express();
  app.disable('x-powered-by');
  // Do not trust browser-supplied Forwarded headers as login source IP.
  app.set('trust proxy',false);
  app.use(headers);
  app.get(['/health','/HobbyCorner/health'],(_req,res)=>res.json({
    service:'hc-isolated-employee-read-pilot',ready:true,
    identity:'synthetic-only',liveBusinessData:false
  }));
  app.get('/',(_req,res)=>res.redirect(302,'/HobbyCorner/'));
  app.get('/HobbyCorner/',(_req,res)=>{
    res.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    return res.type('html').sendFile(
      fileURLToPath(new URL('./employee-read-pilot.html',import.meta.url)));
  });
  for(const [path,filename,type] of [
    ['/HobbyCorner/pilot.js','employee-read-pilot.js','application/javascript'],
    ['/HobbyCorner/pilot.css','employee-read-pilot.css','text/css']
  ])app.get(path,(_req,res)=>{
    res.set('Content-Security-Policy',"default-src 'none'");
    res.type(type).sendFile(fileURLToPath(new URL('./'+filename,import.meta.url)));
  });
  app.use('/HobbyCorner/api/staff-auth',gateway.router);
  app.use('/HobbyCorner/staff-station',createStaffStationProofRouter({workstations:stations}));
  app.post('/HobbyCorner/api/pilot/register-station',
    express.json({limit:'1kb',strict:true}),async(req,res)=>{
      if(req.get('origin')!==environment.HC_PILOT_PUBLIC_ORIGIN)
        return res.status(403).json({error:'Test operator approval required.'});
      const result=await operator.register({
        request:req,publicKeySpki:req.body?.publicKeySpki,label:req.body?.label
      });
      if(!result)return res.status(403).json({error:'Test operator approval required.'});
      return res.json(result);
    });
  // The pilot's exact GET-only approval is applied before fake handlers.
  // This does not import or mount ANY live Special Orders router/database.
  app.use('/HobbyCorner/api/special-orders',pilot.middleware);
  app.get('/HobbyCorner/api/special-orders/orders',(_req,res)=>{
    res.json({synthetic:true,readOnly:true,orders:[]});
  });
  app.get('/HobbyCorner/api/special-orders/stats',(_req,res)=>{
    res.json({synthetic:true,readOnly:true,open:0,overdue:0});
  });
  app.use((_req,res)=>res.status(404).json({error:'Not found in isolated pilot.'}));
  return app;
}

export async function startIsolatedEmployeePilot({environment=process.env}={}){
  assertIsolatedEmployeePilotRuntime(environment);
  const auth=runtimePool(environment,'auth');
  const reader=runtimePool(environment,'reader');
  try{
    const app=await createIsolatedEmployeePilotApp({
      environment,authPool:auth,readerPool:reader
    });
    const port=Number(environment.PORT||3000);
    if(!Number.isInteger(port)||port<1||port>65535)
      throw new Error('Invalid pilot port.');
    const server=app.listen(port,'0.0.0.0');
    server.on('close',()=>{void auth.end();void reader.end();});
    return server;
  }catch(error){
    await Promise.allSettled([auth.end(),reader.end()]);
    throw error;
  }
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
  startIsolatedEmployeePilot().catch(()=>{
    // No secret values, database identifiers, SQL or credentials in logs.
    console.error('Isolated employee pilot failed closed during startup.');
    process.exitCode=1;
  });
}
