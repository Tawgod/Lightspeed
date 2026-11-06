import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecurityStagingApp } from '../staging/staff-security-server.js';
const env={HC_SECURITY_ENV:'isolated-staging',NODE_ENV:'test'};
test('security-only entrypoint refuses production or missing staging marker',()=>{
 for(const bad of [
  {...env,NODE_ENV:'production'},
  {...env,HC_SECURITY_ENV:'production'},
  {NODE_ENV:'test'},
  {}
 ])assert.throws(()=>createSecurityStagingApp({environment:bad}),/Refusing/);
});
test('unconfigured staging exposes only health and returns 503 for employee routes',async()=>{
 const app=createSecurityStagingApp({environment:env});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const healthy=await fetch(base+'/health');
  assert.equal(healthy.status,200);
  assert.equal((await healthy.json()).ready,false);
  for(const endpoint of ['/api/staff-auth/session','/staff-security/','/staff-enrollment-invites/redeem']){
   const r=await fetch(base+endpoint);
   assert.equal(r.status,503);
   assert.equal(r.headers.get('cache-control'),'no-store');
  }
 }finally{await new Promise(ok=>server.close(ok));}
});
