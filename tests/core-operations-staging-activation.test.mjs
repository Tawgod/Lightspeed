import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {createIsolatedStagingCoreAdmission} from '../services/security/coreOperationsStagingActivation.js';
import {createStaffAccessBaseline} from '../services/security/staffAccessBaseline.js';
import {createCoreOperationsRouteAdmission} from '../services/security/coreOperationsRouteAdmission.js';

const stagingEnv=Object.freeze({
 NODE_ENV:'staging',HC_PUBLIC_BASE_PATH:'/HobbyCorner',
 DATABASE_URL:'postgres://isolated-staging-only.invalid/fixture',
 SPECIAL_ORDERS_LIVE_MODE:'false',
 SPECIAL_ORDERS_ALLOW_MIGRATION:'false',
 SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES:'false',
 SCANNER_ENABLED:'false',SCANNER_TEST_CREATION_ENABLED:'false',
 HC_ADMIN_NAV_ENABLED:'false',HC_CORE_SECURITY_STAGING_ENABLED:'true'
});
const read={source:'special-orders.js',method:'GET',path:'/stats',
 audience:'employee',operation:'special-orders.read'};
const priority={...read,path:'/priority-review'};
const write={source:'special-orders.js',method:'POST',path:'/orders',
 audience:'employee',operation:'special-orders.manage'};
const service={source:'special-orders.js',method:'POST',
 path:'/notifications/:id/claim-discord',audience:'service',
 operation:'service.notifications.claim-discord'};
const now=()=>Date.now();
const deny=e=>e?.status===403&&e?.code==='HC_CORE_OPERATIONS_FORBIDDEN';

function cryptographicFixture(){
 // All secrets are regenerated inside this disposable Node process and
 // are NEVER accepted by or configured on the public Railway service.
 const employeeKey=randomBytes(32),stationKey=randomBytes(32);
 const stepKey=randomBytes(32),serviceKey=randomBytes(32);
 const sign=(key,payload)=>{
   const bytes=Buffer.from(JSON.stringify(payload)).toString('base64url');
   return bytes+'.'+createHmac('sha256',key).update(bytes).digest('base64url');
 };
 const verify=(key,token)=>{
  if(typeof token!=='string'||token.length>2048)return null;
  const parts=token.split('.');
  if(parts.length!==2||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))return null;
  const expected=createHmac('sha256',key).update(parts[0]).digest();
  const received=Buffer.from(parts[1],'base64url');
  if(received.length!==expected.length||!timingSafeEqual(expected,received))return null;
  try{
   const value=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
   return value?.expires>now()?value:null;
  }catch{return null;}
 };
 const stamp=()=>({expires:now()+60_000,employeeId:'42'});
 const employee=()=>sign(employeeKey,{...stamp(),id:'42',active:true});
 const station=()=>sign(stationKey,{...stamp(),deviceId:'fixture-desk'});
 const passkey=()=>sign(stepKey,{...stamp(),method:'passkey',authenticatedAtMs:now()-500});
 const serviceToken=()=>sign(serviceKey,{id:'fixture-worker',expires:now()+60_000});
 const staff=createStaffAccessBaseline({
  now,
  verifyEmployeeSession:async req=>{
   const h=req.get('authorization')||'';
   const proof=verify(employeeKey,h.startsWith('Bearer ')?h.slice(7):'');
   return proof?{id:proof.id,active:proof.active}:null;
  },
  verifyWorkstation:async req=>{
   const result=verify(stationKey,req.get('x-fixture-station'));
   return result?{verified:true,deviceId:result.deviceId,expiresAtMs:result.expires}:null;
  },
  verifyStepUp:async req=>{
   const result=verify(stepKey,req.get('x-fixture-strong-proof'));
   return result?{verified:true,employeeId:result.employeeId,method:result.method,authenticatedAtMs:result.authenticatedAtMs}:null;
  },
  checkPermission:async({identity,operation})=>identity.id==='42'&&new Set([
   'special-orders.read','special-orders.manage'
  ]).has(operation)
 });
 const serviceIdentity=async req=>{
  const result=verify(serviceKey,req.get('x-fixture-service'));
  return result?{type:'service',id:result.id,active:true}:null;
 };
 const serviceGrant=async({identity,operation,route})=>identity.id==='fixture-worker'
  && operation==='service.notifications.claim-discord'
  && route.method==='POST'&&route.path==='/notifications/:id/claim-discord';
 return {employee,station,passkey,serviceToken,staff,serviceIdentity,serviceGrant};
}
async function serve(gate){
 const app=express();
 app.use(express.json());
 app.use('/api/special-orders',gate.middleware);
 const reached=[];
 const route=(label)=>(req,res)=>{
  reached.push({label,principal:req.hcCoreOperationsAdmission?.principal,
   operation:req.hcCoreOperationsAdmission?.operation});
  return res.json({ok:true,label});
 };
 app.get('/api/special-orders/stats',route('stats'));
 app.get('/api/special-orders/priority-review',route('priority'));
 app.post('/api/special-orders/orders',route('order-write'));
 app.post('/api/special-orders/notifications/:id/claim-discord',route('worker-claim'));
 const server=await new Promise(resolve=>{
  const value=app.listen(0,'127.0.0.1',()=>resolve(value));
 });
 return {reached,
  url:'http://127.0.0.1:'+server.address().port+'/api/special-orders',
  async stop(){const closing=new Promise(resolve=>server.close(resolve));server.closeAllConnections?.();await closing;}
 };
}
async function status(app,path,options){
 const response=await fetch(app.url+path,{signal:AbortSignal.timeout(8000),...options});
 await response.text();
 return {status:response.status,noStore:response.headers.get('cache-control')};
}
test('guard activates only for isolated staging and rejects any accidentally attached live secret',()=>{
 assert.equal(createIsolatedStagingCoreAdmission({env:{...stagingEnv,HC_CORE_SECURITY_STAGING_ENABLED:'false'}}),null);
 assert.equal(createIsolatedStagingCoreAdmission({env:{...stagingEnv,HC_CORE_SECURITY_STAGING_ENABLED:undefined}}),null);
 for(const bad of [
  {NODE_ENV:'production'},{DATABASE_URL:''},{HC_PUBLIC_BASE_PATH:'/HobbyCorner/other'},
  {SPECIAL_ORDERS_LIVE_MODE:'true'},{SCANNER_ENABLED:'true'},
  {HC_ADMIN_NAV_ENABLED:undefined},{LIGHTSPEED_TOKEN:'do-not-use'},
  {DISCORD_TOKEN:'do-not-use'},{SPECIAL_ORDERS_ADMIN_KEY:'do-not-use'},
  {HC_OWNER_TIMECLOCK_SERVICE_SECRET:'do-not-use'},{HC_CORE_SECURITY_STAGING_ENABLED:'anything'}
 ])assert.throws(()=>createIsolatedStagingCoreAdmission({env:{...stagingEnv,...bad}}));
 const live=createIsolatedStagingCoreAdmission({env:stagingEnv});
 assert.ok(live?.middleware);
});
test('public staging guard has no synthetic identity path, no approvals, and cannot bypass with forged headers',async()=>{
 const live=createIsolatedStagingCoreAdmission({env:stagingEnv});
 const fixture=cryptographicFixture();
 const app=await serve(live);
 try{
  const attempts=[
   {method:'GET',path:'/stats',headers:{}},
   {method:'GET',path:'/stats',headers:{'x-hc-role':'owner'}},
   {method:'GET',path:'/stats',headers:{authorization:'Bearer '+fixture.employee(),'x-fixture-station':fixture.station()}},
   {method:'POST',path:'/orders',headers:{'x-hobby-corner-key':'old-key'}},
   {method:'POST',path:'/notifications/7/claim-discord',headers:{'x-fixture-service':fixture.serviceToken()}}
  ];
  for(const a of attempts){
   const result=await status(app,a.path,{method:a.method,headers:a.headers});
   assert.equal(result.status,403);
   assert.equal(result.noStore,'no-store');
  }
  assert.deepEqual(app.reached,[],'Guard must deny before real handlers');
 }finally{await app.stop();}
});
test('in-process synthetic staff session and independently signed station / strong factor admit only exact scopes',async()=>{
 const f=cryptographicFixture();
 const gate=createCoreOperationsRouteAdmission({approvedRoutes:[read,priority,write],
  staffAccess:f.staff});
 const app=await serve(gate);
 try{
  const auth={authorization:'Bearer '+f.employee()};
  assert.equal((await status(app,'/stats',{headers:auth})).status,403);
  assert.equal((await status(app,'/stats',{headers:{...auth,'x-hc-role':'owner','x-trusted-device':'true'}})).status,403);
  assert.equal((await status(app,'/stats',{headers:{...auth,'x-fixture-station':f.station()}})).status,200);
  assert.equal((await status(app,'/priority-review',{headers:{...auth,'x-fixture-station':f.station()}})).status,200);
  assert.equal((await status(app,'/orders',{method:'POST',headers:{...auth,'x-fixture-station':f.station()}})).status,403);
  assert.equal((await status(app,'/orders',{method:'POST',headers:{...auth,'x-fixture-strong-proof':f.passkey()}})).status,200);
  assert.equal((await status(app,'/orders',{method:'POST',headers:{...auth,'x-fixture-strong-proof':f.passkey()+'.tampered'}})).status,403);
  assert.deepEqual(app.reached.map(r=>r.label),['stats','priority','order-write']);
 }finally{await app.stop();}
});
test('in-process worker uses an independently signed scoped service credential, never an employee/owner token',async()=>{
 const f=cryptographicFixture();
 const gate=createCoreOperationsRouteAdmission({approvedRoutes:[service],
  staffAccess:f.staff,verifyServiceRequest:f.serviceIdentity,checkServiceGrant:f.serviceGrant});
 const app=await serve(gate);
 try{
  assert.equal((await status(app,'/notifications/7/claim-discord',{method:'POST',headers:{'x-hc-service':'fixture-worker'}})).status,403);
  assert.equal((await status(app,'/notifications/7/claim-discord',{method:'POST',headers:{authorization:'Bearer '+f.employee(),'x-fixture-station':f.station()}})).status,403);
  assert.equal((await status(app,'/notifications/7/claim-discord',{method:'POST',headers:{'x-fixture-service':f.serviceToken()}})).status,200);
  assert.equal((await status(app,'/orders',{method:'POST',headers:{'x-fixture-service':f.serviceToken()}})).status,403);
  assert.deepEqual(app.reached.map(r=>r.label),['worker-claim']);
 }finally{await app.stop();}
});
