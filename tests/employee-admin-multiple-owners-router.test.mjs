import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createEmployeeAdminRouter} from '../routes/employeeAdmin.js';

test('Owner management route uses only strongly gated backend delegation and rejects client role injection',async()=>{
 const calls=[];
 const auth={authorize:async()=>({employeeId:'901',method:'passkey'})};
 const denied=()=>Object.assign(new Error('No strong Owner approval'),{status:403});
 const delegations={
  capabilitiesForVerifiedEmployee:async()=>({role:'owner',operations:['admin.read']}),
  listGrants:async()=>({}),changeAdminGrant:async()=>{},
  changeGrantScope:async()=>{},changeSettingScope:async()=>{},
  changeEmployeeToolGrant:async()=>{},listEmployeeToolGrants:async()=>{},
  changeOwnerRole:async args=>{
   calls.push(args);
   if(args.context.get('x-strong-proof')!=='verified'||args.targetEmployeeId==='901')throw denied();
   return {employeeId:args.targetEmployeeId,role:'owner',active:args.enabled};
  }
 };
 const app=express();
 app.use('/admin',createEmployeeAdminRouter({adminAccess:auth,delegations}));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try {
  const endpoint='http://127.0.0.1:'+server.address().port+'/admin/api/owners';
  const post=(body,headers={})=>fetch(endpoint,{
   method:'POST',headers:{'Content-Type':'application/json',...headers},
   body:JSON.stringify(body)
  });
  const valid={targetEmployeeId:'902',enabled:true,reason:'Appoint verified additional Owner'};
  let response=await post({...valid,role:'owner'},{'x-strong-proof':'verified'});
  assert.equal(response.status,400);
  assert.equal(calls.length,0,'browser role claim must not reach delegate');
  response=await post({...valid,targetEmployeeId:'901'},{'x-strong-proof':'verified'});
  assert.equal(response.status,403,'the backend refuses owner self-appointment');
  response=await post(valid);
  assert.equal(response.status,403,'missing strong proof is rejected by backend');
  response=await post(valid,{'x-strong-proof':'verified'});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{employeeId:'902',role:'owner',active:true});
  assert.equal(calls.at(-1).targetEmployeeId,'902');
  assert.equal(calls.at(-1).enabled,true);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
