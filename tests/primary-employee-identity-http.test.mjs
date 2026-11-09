import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createPrimaryEmployeeIdentityRouter} from '../routes/primaryEmployeeIdentity.js';
import {createPrimaryEmployeeIdentityDiscovery} from '../services/security/primaryEmployeeIdentityDiscovery.js';

const NOW=Date.parse('2026-11-09T20:00:00Z');
const session={id:'42',employeeId:'42',active:true,
 binding:'signed-primary-session-binding-001',expiresAtMs:NOW+60000};
function discovery(counters){
 return createPrimaryEmployeeIdentityDiscovery({
  now:()=>NOW,
  verifyBoundEmployee:async req=>{
   counters.sessions++;
   if(req.get('authorization')!=='Bearer good')throw Error('No session');
   return session;
  },
  verifyCanonicalTimeclockEmployee:async ({employeeId})=>{
   counters.canonical++;
   return {source:'timeclock',employeeId,active:true};
  },
  checkOwnerAssignment:async()=>{
   counters.owner++;
   return false;
  }
 });
}
async function serve(enabled){
 const counters={sessions:0,canonical:0,owner:0};
 const app=express();
 app.use('/api/primary',createPrimaryEmployeeIdentityRouter({
  identityDiscovery:discovery(counters),enabled
 }));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 return {url:'http://127.0.0.1:'+server.address().port+'/api/primary',
  counters,close:()=>new Promise(resolve=>server.close(resolve))};
}
test('self route remains unavailable by default, with no identity lookups',async()=>{
 const s=await serve(false);
 try{
  const response=await fetch(s.url+'/self',{headers:{authorization:'Bearer good'}});
  assert.equal(response.status,503);
  assert.deepEqual(s.counters,{sessions:0,canonical:0,owner:0});
  assert.equal(response.headers.get('cache-control'),'no-store');
 }finally{await s.close();}
});
test('self endpoint verifies signed session and discloses only explicitly safe readiness',async()=>{
 const s=await serve(true);
 try{
  const res=await fetch(s.url+'/self',{headers:{authorization:'Bearer good'}});
  assert.equal(res.status,200);
  assert.deepEqual(await res.json(),{
   readOnly:true,employeeId:'42',canonicalTimeclockIdentityVerified:true,
   independentlyAppointedOwner:false,nextGate:'independent-owner-commissioning',
   enrollmentAuthorized:false
  });
  assert.deepEqual(s.counters,{sessions:1,canonical:1,owner:1});
  assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(res.headers.get('x-content-type-options'),'nosniff');
 }finally{await s.close();}
});
test('missing base session and spoofed employee query never read canonical directory',async()=>{
 const s=await serve(true);
 try{
  const response=await fetch(s.url+'/self?employeeId=901&role=owner');
  assert.equal(response.status,403);
  assert.deepEqual(s.counters,{sessions:1,canonical:0,owner:0});
  assert.deepEqual(await response.json(),{error:'Employee verification required.'});
 }finally{await s.close();}
});
test('no credential writer or enrollment route is exposed',async()=>{
 const s=await serve(true);
 try{
  for(const [method,path] of [['POST','/self'],['POST','/enroll'],['PUT','/self'],['GET','/employees/42']]){
   const response=await fetch(s.url+path,{method});
   assert.equal(response.status,404,method+' '+path);
  }
  assert.deepEqual(s.counters,{sessions:0,canonical:0,owner:0});
 }finally{await s.close();}
});
test('router requires trusted server-side identity adapter',()=>{
 assert.throws(()=>createPrimaryEmployeeIdentityRouter(),TypeError);
});
