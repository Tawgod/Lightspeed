import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createEmployeeAdminRouter} from '../routes/employeeAdmin.js';
import {DEFAULT_STAFF_SESSION_POLICY,previewStaffSessionPolicy} from '../services/security/adminSessionPolicy.js';

test('policy preview is read-only, exact grant checked, and unavailable when adapter absent',async()=>{
 let allowed=false,reads=0,writes=0;
 const policy=DEFAULT_STAFF_SESSION_POLICY;
 const adminAccess={authorize:async({operation})=>{
  if(operation!=='sessions.policy.read'||!allowed)
   throw Object.assign(new Error('denied'),{status:403});
  return {employeeId:'901',method:'totp'};
 }};
 const store={
  current:async({context})=>{
   await adminAccess.authorize({context,operation:'sessions.policy.read'});reads++;
   return {version:1,policy,changedAt:'2026-11-09T00:00:00.000Z'};
  },
  preview:async({context,policy:next})=>{
   await adminAccess.authorize({context,operation:'sessions.policy.read'});reads++;
   return {readOnly:true,applied:false,changes:previewStaffSessionPolicy({current:policy,next})};
  },
  update:async()=>{writes++;throw Error('MUST NEVER CALL');}
 };
 const app=express(),off=express();
 app.use('/admin',createEmployeeAdminRouter({adminAccess,sessionPolicyStore:store}));
 off.use('/admin',createEmployeeAdminRouter({adminAccess}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const offServer=await new Promise(resolve=>{const s=off.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const root='http://127.0.0.1:'+server.address().port+'/admin/api/session-policy';
  assert.equal((await fetch(root)).status,403);
  allowed=true;
  const current=await fetch(root);
  assert.equal(current.status,200);
  assert.equal((await current.json()).version,1);
  const next={'approved-workstation':{idleSeconds:1800,absoluteSeconds:28800},
   remote:{idleSeconds:900,absoluteSeconds:3600}};
  const post=body=>fetch(root+'/preview',{method:'POST',
   headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const preview=await post({policy:next});
  assert.equal(preview.status,200);
  const result=await preview.json();
  assert.equal(result.readOnly,true);
  assert.equal(result.applied,false);
  assert.equal(result.changes.length,2);
  assert.equal((await post({policy:{...next,remote:{idleSeconds:1,absoluteSeconds:3600}}})).status,400);
  assert.equal((await post({policy:next,extra:true})).status,400);
  assert.equal((await fetch(root,{method:'PATCH'})).status,404);
  assert.equal(writes,0);
  assert.equal(reads,2);
  assert.equal((await fetch('http://127.0.0.1:'+offServer.address().port+'/admin/api/session-policy')).status,404);
 }finally{
  await new Promise(resolve=>server.close(resolve));
  await new Promise(resolve=>offServer.close(resolve));
 }
});
