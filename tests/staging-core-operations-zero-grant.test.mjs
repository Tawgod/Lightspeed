import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {readFileSync} from 'node:fs';
import {createIsolatedStagingZeroGrantGuard} from '../services/security/stagingCoreOperationsGuard.js';
import {createSpecialOrdersRouter} from '../special-orders.js';
const safe={
 NODE_ENV:'staging',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_CORE_GUARD_ENABLED:'true',
 SPECIAL_ORDERS_LIVE_MODE:'false',
 SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES:'false',
 SPECIAL_ORDERS_ALLOW_MIGRATION:'false',
 SCANNER_ENABLED:'false',HC_ADMIN_NAV_ENABLED:'false'
};
const fixture=(extra={})=>({...safe,...extra});
const deny=async(port,path,method='GET',headers={})=>{
 const r=await fetch('http://127.0.0.1:'+port+path,{method,headers});
 const text=await r.text();
 assert.equal(r.status,403,method+' '+path+' unexpectedly accepted: '+text.slice(0,80));
 assert.match(text,/Core Operations permission required/);
};
test('staging-only zero-grant gate rejects unsafe env and does not activate by default',()=>{
 assert.equal(createIsolatedStagingZeroGrantGuard({...safe,HC_STAGING_CORE_GUARD_ENABLED:'false'}),undefined);
 for(const value of [
  {NODE_ENV:'production'},{NODE_ENV:'test'},
  {HC_SECURITY_ENV:'production'},{LIGHTSPEED_TOKEN:'live'},
  {DISCORD_TOKEN:'live'},{SPECIAL_ORDERS_ADMIN_KEY:'legacy'},
  {HC_ADMIN_GRANTS_DATABASE_URL:'postgres://prod'},
  {SCANNER_ENABLED:'true'},{SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES:'true'},
  {SPECIAL_ORDERS_LIVE_MODE:undefined}
 ])assert.throws(()=>createIsolatedStagingZeroGrantGuard(fixture(value)));
 assert.equal(typeof createIsolatedStagingZeroGrantGuard(fixture()).middleware,'function');
});
test('real Express router has public health but denies all employee/service API routes and forged headers',async()=>{
 const app=express();
 app.use(express.json());
 const guard=createIsolatedStagingZeroGrantGuard(fixture());
 app.use('/api/special-orders',createSpecialOrdersRouter({
  lightspeedDomain:null,lightspeedToken:null,adminKey:null,
  coreOperationsAdmission:guard
 }));
 const server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 try{
  const port=server.address().port;
  const health=await fetch('http://127.0.0.1:'+port+'/api/special-orders/health');
  assert.equal(health.status,200);
  assert.equal((await health.json()).lightspeed,false);
  for(const path of [
   '/api/special-orders/stats',
   '/api/special-orders/priority-review',
   '/api/special-orders/items',
   '/api/special-orders/notifications/delivery-queue',
   '/api/special-orders/preorders/discord-watch'
  ])await deny(port,path);
  for(const headers of [
   {'x-hobby-corner-key':'forged'},
   {'authorization':'Bearer signed-staff-fixture'},
   {'x-hc-role':'owner','x-hc-employee-id':'901'},
   {'x-service-id':'discord-worker','authorization':'Bearer service-guess'}
  ])await deny(port,'/api/special-orders/priority-review','GET',headers);
  await deny(port,'/api/special-orders/reconcile/products','POST',
   {'content-type':'application/json'});
 }finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}
});
test('server only obtains route guard from trusted env, never from request payload',()=>{
 const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(source,/const isolatedCoreOperationsAdmission=createIsolatedStagingZeroGrantGuard\(process\.env\)/);
 assert.match(source,/coreOperationsAdmission:isolatedCoreOperationsAdmission/);
 assert.doesNotMatch(source,/HC_STAGING_CORE_GUARD_ENABLED.*req\./);
});
