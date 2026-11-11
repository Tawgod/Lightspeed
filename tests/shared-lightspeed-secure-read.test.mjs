import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createStaffAccessBaseline} from '../services/security/staffAccessBaseline.js';
import {createSecuredSharedLightspeedReadPolicy} from '../services/lightspeed/secureReadPolicy.js';
import {createSharedLightspeedReadRouter} from '../routes/sharedLightspeedRead.js';
import {employeeRequestPrincipal} from '../services/lightspeed/staffAdapter.js';

const NOW=Date.parse('2026-11-09T18:00:00Z');
const request=(token='signed')=>({get:name=>name==='authorization'?'Bearer '+token:undefined});
const station=async()=>({verified:true,deviceId:'enrolled-1',expiresAtMs:NOW+30000});
const totp=async()=>({verified:true,employeeId:'17',method:'totp',authenticatedAtMs:NOW-2000});
function build({session,workstation=station,stepUp,toolGrant=async()=>true,readGrant=async()=>true}={}){
 const access=createStaffAccessBaseline({
  now:()=>NOW,
  verifyEmployeeSession:session|| (async req=>{
   if(req.get('authorization')!=='Bearer signed')throw Error('Invalid signed session');
   return {id:17,active:true,clockedIn:false,scheduled:false};
  }),
  verifyWorkstation:workstation,
  verifyStepUp:stepUp,
  checkPermission:async ({operation})=>operation==='tools.read'&&await toolGrant()
 });
 return createSecuredSharedLightspeedReadPolicy({staffAccess:access,checkReadGrant:readGrant});
}
const principal=token=>employeeRequestPrincipal(request(token));
const authorize=(policy,operation='purchase-orders.read',token='signed')=>policy.authorize({
 principal:principal(token),operation,mode:'read',environment:'test'
});
const forbidden=e=>e?.code==='LIGHTSPEED_FORBIDDEN'&&e?.status===403;

test('active off-clock and unscheduled Timeclock employee with independently registered device and exact grants can read',async()=>{
 let exact;
 const policy=build({readGrant:async data=>{exact=data;return true;}});
 const result=await authorize(policy);
 assert.equal(result.identityId,'17');
 assert.equal(result.operation,'purchase-orders.read');
 assert.deepEqual(exact,{employeeId:'17',operation:'purchase-orders.read',environment:'test'});
});
test('clocked-in status never substitutes for signed session, station, or an exact grant',async()=>{
 const onClock=async()=>({id:17,active:true,clockedIn:true});
 await assert.rejects(authorize(build({session:onClock,workstation:undefined,stepUp:undefined,
  toolGrant:async()=>false})),forbidden);
 await assert.rejects(authorize(build({session:onClock,workstation:async()=>null,
  stepUp:undefined})),forbidden);
 await assert.rejects(authorize(build({session:onClock,readGrant:async()=>false})),forbidden);
});
test('revoked staff, raw employee claims, forged client trust, and missing read grants fail closed',async()=>{
 await assert.rejects(authorize(build(), 'purchase-orders.read','spoofed'),forbidden);
 await assert.rejects(authorize(build({session:async()=>({id:17,active:false})})),forbidden);
 await assert.rejects(authorize(build({session:async()=>({id:0,active:true})})),forbidden);
 const req={get:()=>undefined,body:{employeeId:17,role:'owner'},headers:{'x-trusted-device':'true'}};
 await assert.rejects(build().authorize({principal:{type:'employee',request:req},
  mode:'read',operation:'purchase-orders.read',environment:'test'}),forbidden);
 await assert.rejects(authorize(build({readGrant:async()=>{throw Error('db unavailable')}})),forbidden);
});
test('remote independently validated TOTP permits routine reads, never writes',async()=>{
 const policy=build({workstation:async()=>null,stepUp:totp});
 assert.equal((await authorize(policy,'products.exact')).identityId,'17');
 await assert.rejects(policy.authorize({principal:principal('signed'),mode:'write',
  operation:'products.create',environment:'test'}),forbidden);
 await assert.rejects(policy.authorize({principal:principal('signed'),mode:'read',
  operation:'products.create',environment:'test'}),forbidden);
});
test('no service identity, unknown operations or permission shortcuts',async()=>{
 const policy=build();
 await assert.rejects(policy.authorize({principal:{type:'service',id:'arbitrary'},
  mode:'read',operation:'products.exact',environment:'test'}),forbidden);
 await assert.rejects(authorize(policy,'unknown.read'),forbidden);
 assert.throws(()=>createSecuredSharedLightspeedReadPolicy(),TypeError);
 assert.throws(()=>createSecuredSharedLightspeedReadPolicy({staffAccess:{authorize:async()=>({})}}),TypeError);
});
test('shared read HTTP route never invokes vendor API without independent admission and exact permission',async()=>{
 let reads=0;
 const app=express();
 app.use('/api/hc-lightspeed',createSharedLightspeedReadRouter({
  policy:build({
   readGrant:async ({operation})=>operation==='purchase-orders.read'
  }),
  environment:'test',
  customers:{search:async()=>{reads++;return [];}},
  purchaseOrders:{get:async id=>{reads++;return {id,status:'OPEN',lines:[]};}}
 }));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const base='http://127.0.0.1:'+server.address().port+'/api/hc-lightspeed';
  let res=await fetch(base+'/purchase-orders/PO1');
  assert.equal(res.status,403);assert.equal(reads,0);
  res=await fetch(base+'/customers/search?q=Jane',{headers:{authorization:'Bearer signed'}});
  assert.equal(res.status,403);assert.equal(reads,0);
  res=await fetch(base+'/purchase-orders/PO1',{headers:{authorization:'Bearer signed'}});
  assert.equal(res.status,200);assert.equal(reads,1);
  const body=await res.json();
  assert.equal(body.readOnly,true);assert.equal(body.data.id,'PO1');
  assert.equal(res.headers.get('cache-control'),'no-store');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
