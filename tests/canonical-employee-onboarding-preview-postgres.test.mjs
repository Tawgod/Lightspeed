import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {validateCanonicalEmployeePreviewEnvironment,
  createCanonicalEmployeeDiscoveryApp,
  verifyCanonicalDiscoveryRuntimeRole
} from '../services/security/canonicalEmployeeDiscoveryPreview.js';

const PIN='1234'; // disposable CI fixture, never a real employee credential
const SEC=()=>randomBytes(48).toString('base64url');
const PUBLIC='https://primary-staff-preview-test.up.railway.app';
const TIMECLOCK='http://timeclock.railway.internal';
function env(){return {
  NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
  HC_PRIMARY_EMPLOYEE_DISCOVERY_ENABLED:'true',
  HC_PUBLIC_BASE_PATH:'/HobbyCorner',
  HC_PRIMARY_DISCOVERY_ORIGIN:PUBLIC,HC_PRIMARY_TIMECLOCK_ORIGIN:TIMECLOCK,
  HC_PRIMARY_TIMECLOCK_SERVICE_SECRET:SEC(),
  HC_PRIMARY_SESSION_SECRET:SEC(),HC_PRIMARY_THROTTLE_SECRET:SEC(),
  HC_STAGING_TEST_LOGIN_ENABLED:'false',
  HC_CORE_EMPLOYEE_PILOT_ENABLED:'false',
  HC_OWNER_STAGING_ENABLED:'false',
  SPECIAL_ORDERS_LIVE_MODE:'false',SCANNER_ENABLED:'false',
  SPECIAL_ORDERS_ALLOW_MIGRATION:'false',
  SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES:'false',HC_ADMIN_NAV_ENABLED:'false'
};}
test('primary discovery readiness rejects live, synthetic, cross-origin, reused-secret and production configurations',()=>{
  const e=env();assert.deepEqual(validateCanonicalEmployeePreviewEnvironment(e),{ready:true,issues:[]});
  for(const bad of [
    {NODE_ENV:'production'},{HC_SECURITY_ENV:'production'},
    {HC_STAGING_TEST_LOGIN_ENABLED:'true'},
    {HC_CORE_EMPLOYEE_PILOT_ENABLED:'true'},
    {HC_OWNER_STAGING_ENABLED:'true'},
    {SPECIAL_ORDERS_LIVE_MODE:'true'},
    {LIGHTSPEED_TOKEN:'vendor'},
    {HC_OWNER_TIMECLOCK_SERVICE_SECRET:'secret'},
    {DATABASE_URL:'postgres://admin:password@real-database'},
    {HC_PRIMARY_DISCOVERY_ORIGIN:'http://localhost:3000'},
    {HC_PRIMARY_TIMECLOCK_ORIGIN:'http://public.example'},
    {HC_PRIMARY_TIMECLOCK_ORIGIN:'https://evil.example/redirect'},
    {HC_PRIMARY_SESSION_SECRET:e.HC_PRIMARY_THROTTLE_SECRET}
  ])assert.equal(validateCanonicalEmployeePreviewEnvironment({...e,...bad}).ready,false,
    JSON.stringify(Object.keys(bad)));
});
test('unprivileged runtime preflight fails closed for missing connection',async()=>{
  assert.equal(await verifyCanonicalDiscoveryRuntimeRole(null),false);
  assert.equal(await verifyCanonicalDiscoveryRuntimeRole({query:async()=>{throw Error('down');}}),false);
});
const db=process.env.HC_TEST_DATABASE_URL;
test('canonical signed live-like Timeclock identity flow admits only self inspection; no Owner by role',
  {skip:!db?'Requires disposable PostgreSQL hc_test':false},async()=>{
  const url=new URL(db);
  if(!['localhost','127.0.0.1'].includes(url.hostname)||
      url.pathname!=='/hc_test')throw Error('Refusing non-disposable PostgreSQL.');
  const admin=new pg.Pool({connectionString:db,max:3});
  const username='hc_primary_preview_test_reader';
  const password=SEC();
  let pool,server;
  try{
    await admin.query(`CREATE TABLE IF NOT EXISTS public.hc_staff_auth_throttle (
      key_hash char(64) PRIMARY KEY,
      balance double precision NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )`);
    await admin.query('CREATE ROLE '+username+" LOGIN PASSWORD '"+password+"'");
    await admin.query('GRANT USAGE ON SCHEMA public TO '+username);
    await admin.query('GRANT SELECT,INSERT,UPDATE ON public.hc_staff_auth_throttle TO '+username);
    const roleUrl=new URL(db);roleUrl.username=username;roleUrl.password=password;
    pool=new pg.Pool({connectionString:roleUrl.toString(),max:3});
    assert.equal(await verifyCanonicalDiscoveryRuntimeRole(pool),true);
    await assert.rejects(pool.query('CREATE TABLE public.hc_illegal_preview_table(id INT)'),e=>e?.code==='42501');
    await assert.rejects(pool.query('DELETE FROM public.hc_staff_auth_throttle'),e=>e?.code==='42501');

    const e=env(),seen=[],ownerCalls=[];
    let canonicalStatus='active',idForPin='42';
    const fetchImpl=async(url,options)=>{
      const u=new URL(url),payload=JSON.parse(options.body);
      seen.push({path:u.pathname,keys:Object.keys(payload),secret:
        options.headers['x-scanner-service-secret']});
      if(options.headers['x-scanner-service-secret']!==e.HC_PRIMARY_TIMECLOCK_SERVICE_SECRET)
        throw Error('Missing trusted server secret');
      if(options.method!=='POST'||u.origin!==TIMECLOCK)
        throw Error('Unapproved Timeclock host/method');
      if(canonicalStatus==='down')throw Error('Timeclock offline');
      if(canonicalStatus==='revoked')return {ok:false,status:403};
      const employeeId=u.pathname.endsWith('/verify-pin')?idForPin:payload.employeeId;
      if(u.pathname.endsWith('/verify-pin')&&payload.pin!==PIN)
        return {ok:false,status:401};
      return {ok:true,json:async()=>({employee:{
        id:employeeId,name:'Fixture employee',canLookup:true,canApprove:true,
        role:'owner',permissionSource:canonicalStatus==='synthetic'
          ?'synthetic_staging_only':'timeclock_employee'
      }})};
    };
    const {app}=await createCanonicalEmployeeDiscoveryApp({
      environment:e,pool,fetchImpl,
      checkOwnerAssignment:async({employeeId})=>{
        ownerCalls.push(employeeId);return false;
      }
    });
    server=await new Promise(resolve=>{
      const s=app.listen(0,'127.0.0.1',()=>resolve(s));
    });
    const origin='http://127.0.0.1:'+server.address().port;
    async function req(path,{method='GET',headers={},body}={}){
      const response=await fetch(origin+path,{
        method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},
        ...(body?{body:JSON.stringify(body)}:{}),
        redirect:'manual',signal:AbortSignal.timeout(8000)
      });
      return {status:response.status,body:await response.json()};
    }
    const base='/HobbyCorner/api';
    const postLogin=(body,headers={origin:PUBLIC,'sec-fetch-site':'same-origin'})=>
      req(base+'/staff-auth/session',{method:'POST',headers,body});
    assert.equal((await req('/health')).body.realEmployeeGrants,false);
    assert.equal((await postLogin({pin:PIN})).status,401,
      'Selected ID is required before PIN verification');
    assert.equal((await postLogin({pin:PIN,employeeId:'901'})).status,401,
      'reserved synthetic ID is not eligible');
    assert.equal((await postLogin({pin:PIN,employeeId:'42'},
      {origin:'https://attacker.example'})).status,403);
    assert.equal((await postLogin({pin:PIN,employeeId:'42'},
      {origin:PUBLIC,'sec-fetch-site':'cross-site'})).status,403);
    assert.deepEqual(seen,[],'invalid and cross-site requests do not contact Timeclock');
    idForPin='43';
    assert.equal((await postLogin({pin:PIN,employeeId:'42'})).status,401,
      'PIN for a different employee cannot establish a signed session');
    idForPin='42';
    const logged=await postLogin({pin:PIN,employeeId:'42'});
    assert.equal(logged.status,200);
    assert.equal(logged.body.employee.id,'42');
    assert.ok(typeof logged.body.token==='string');
    assert.equal(logged.body.employee.permissionSource,'timeclock_employee');
    const self=await req(base+'/primary/self',{
      headers:{authorization:'Bearer '+logged.body.token}
    });
    assert.equal(self.status,200);
    assert.deepEqual(self.body,{
      readOnly:true,employeeId:'42',canonicalTimeclockIdentityVerified:true,
      independentlyAppointedOwner:false,nextGate:'independent-owner-commissioning',
      enrollmentAuthorized:false
    });
    assert.deepEqual(ownerCalls,['42']);
    assert.ok(seen.some(x=>x.path.endsWith('/verify-pin')));
    assert.ok(seen.some(x=>x.path.endsWith('/authorize')));
    assert.ok(seen.every(x=>x.secret===e.HC_PRIMARY_TIMECLOCK_SERVICE_SECRET));
    assert.equal((await req(base+'/primary/self')).status,403);
    for(const [method,path] of [
      ['GET','/special-orders/orders'],['POST','/primary/enroll'],
      ['POST','/admin/appoint-owner'],['POST','/staff-security/totp'],
      ['POST','/primary/self']]){
      assert.equal((await req(base+path,{method})).status,404,
        method+' '+path+' must not be mounted');
    }
    canonicalStatus='revoked';
    assert.notEqual((await req(base+'/primary/self',{
      headers:{authorization:'Bearer '+logged.body.token}
    })).status,200,'revoked employee must lose access on recheck');
    assert.deepEqual(ownerCalls,['42'],
      'revoked employee never reaches Owner lookup');
    canonicalStatus='down';
    assert.notEqual((await req(base+'/primary/self',{
      headers:{authorization:'Bearer '+logged.body.token}
    })).status,200,'outage must deny');
  }finally{
    if(server)await new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);});
    if(pool)await pool.end();
    await admin.query('DROP OWNED BY '+username).catch(()=>{});
    await admin.query('DROP ROLE '+username).catch(()=>{});
    await admin.end();
  }
});
