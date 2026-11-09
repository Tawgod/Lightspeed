import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import {createAdminOnboardingQueue} from '../services/security/adminOnboardingQueue.js';
import {createEmployeeAdminRouter} from '../routes/employeeAdmin.js';

const url=process.env.HC_TEST_DATABASE_URL;
const testSettings={skip:!url?'Disposable PostgreSQL required':false};
test('delegated manager onboarding is request-only, strong-gated, private and idempotent',testSettings,async()=>{
 if(!/hc_test/.test(url))throw Error('Refusing non-disposable database');
 const pool=new pg.Pool({connectionString:url});
 let employeeId='902',strong=true,permitted=true;
 const gate={authorize:async({operation,requireStrong})=>{
  if(operation!=='employees.onboard'||!permitted||(requireStrong&&!strong))
   throw Object.assign(new Error('denied'),{status:403});
  return {employeeId,method:strong?'passkey':'totp'};
 }};
 const queue=createAdminOnboardingQueue({pool,adminAccess:gate});
 try{
  await pool.query(await readFile(new URL('../db/hc_admin_onboarding_requests.sql',import.meta.url),'utf8'));
  await pool.query('DELETE FROM hc_admin_onboarding_requests');
  const key='46f4da52-b2bf-423c-895e-8342bd4f198a';
  const request={context:{},requestKey:key,name:' New Employee ',requestedRole:'staff',
   reason:'Hiring for the weekend shift'};
  strong=false;
  await assert.rejects(queue.request(request),e=>e.status===403);
  strong=true;
  const first=await queue.request(request);
  assert.equal(first.status,'pending_review');
  assert.equal(first.submittedBy,'902');
  assert.equal(first.replayed,false);
  const retry=await queue.request(request);
  assert.equal(retry.requestId,first.requestId);
  assert.equal(retry.replayed,true);
  await assert.rejects(queue.request({...request,name:'Someone Else'}),e=>e.status===400);
  await assert.rejects(queue.request({...request,requestKey:'invalid'}),e=>e.status===400);
  await assert.rejects(queue.request({...request,requestKey:'dd78cfc9-c005-4e63-b643-aa376a60e0c7',name:'<script>alert(1)</script>'}),e=>e.status===400);
  const events=await pool.query('SELECT count(*) AS n FROM hc_admin_onboarding_events');
  assert.equal(Number(events.rows[0].n),1);
  const records=await pool.query('SELECT count(*) AS n FROM hc_admin_onboarding_requests');
  assert.equal(Number(records.rows[0].n),1);
  const mine=await queue.ownRequests({context:{}});
  assert.equal(mine.items.length,1);
  assert.equal(mine.items[0].name,'New Employee');
  assert.equal(mine.items[0].ownOnly,undefined);
  employeeId='903';
  assert.equal((await queue.ownRequests({context:{}})).items.length,0);
  permitted=false;
  await assert.rejects(queue.ownRequests({context:{}}),e=>e.status===403);
  await assert.rejects(pool.query('DELETE FROM hc_admin_onboarding_events'),/append-only/);
 }finally{await pool.end();}
});
test('onboarding routes are unmounted without approved adapter and cannot create Timeclock staff',async()=>{
 let enabled=false,submissions=0;
 const queue={
  ownRequests:async()=>{if(!enabled)throw Object.assign(new Error('denied'),{status:403});
   return {items:[],ownOnly:true,readOnly:true};},
  request:async()=>{if(!enabled)throw Object.assign(new Error('denied'),{status:403});
   submissions++;return {requestId:'synthetic',status:'pending_review',replayed:false};}
 };
 const auth={authorize:async()=>({employeeId:'901'})};
 const app=express(),off=express();
 app.use('/admin',createEmployeeAdminRouter({adminAccess:auth,onboardingQueue:queue}));
 off.use('/admin',createEmployeeAdminRouter({adminAccess:auth}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 const offServer=await new Promise(resolve=>{const s=off.listen(0,'127.0.0.1',()=>resolve(s))});
 try{
  const root='http://127.0.0.1:'+server.address().port+'/admin/api/onboarding/requests';
  const payload={name:'Synthetic Employee',requestedRole:'staff',reason:'Manager request for hiring',requestKey:'11111111-2222-4333-8444-555555555555'};
  const post=body=>fetch(root,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post(payload)).status,403);
  enabled=true;
  assert.equal((await post({...payload,extra:'private'})).status,400);
  assert.equal((await post(payload)).status,202);
  assert.equal(submissions,1);
  assert.equal((await fetch(root)).status,200);
  const noRoute=await fetch('http://127.0.0.1:'+offServer.address().port+'/admin/api/onboarding/requests');
  assert.equal(noRoute.status,404);
  assert.equal((await fetch(root,{method:'DELETE'})).status,404);
 }finally{
  await new Promise(resolve=>server.close(resolve));
  await new Promise(resolve=>offServer.close(resolve));
 }
});
