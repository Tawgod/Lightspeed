import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createAdminEmployeeDirectory} from '../services/security/adminEmployeeDirectory.js';
import {createEmployeeAdminRouter} from '../routes/employeeAdmin.js';

const records=[
 {id:901,name:'Synthetic Owner',active:true,has_pin:true,pto_eligible:false,
  discord_user_id:'private-id',lightspeed_user_id:'LS-1',
  scanner_can_lookup:true,scanner_can_approve:true,
  pin_hash:'SECRET',email:'private@example.test',phone:'private'},
 {id:902,name:'Synthetic Manager',active:true,has_pin:false,pto_eligible:true,
  discord_user_id:null,lightspeed_user_id:null,
  scanner_can_lookup:false,scanner_can_approve:false}
];
const directory=createAdminEmployeeDirectory({readTimeclockEmployees:async()=>records});
test('Timeclock minimum employee directory projects only identity, name, active',async()=>{
 const result=await directory.list();
 assert.equal(result.readOnly,true);
 assert.equal(result.source,'timeclock');
 assert.deepEqual(Object.keys(result.employees[0]).sort(),['active','id','name']);
 assert.equal(result.employees[0].id,'901');
 assert.doesNotMatch(JSON.stringify(result),/private-id|SECRET|private@example|LS-1/);
});
test('private employee view exposes approved status booleans but never raw credentials',async()=>{
 const result=await directory.list({includePrivate:true});
 assert.equal(result.scope,'private');
 assert.equal(result.employees[0].hasPin,true);
 assert.equal(result.employees[0].ptoEligible,false);
 assert.equal(result.employees[0].discordLinked,true);
 assert.doesNotMatch(JSON.stringify(result),/pin_hash|SECRET|private-id|private@example|LS-1/);
});
test('directory rejects malformed records, duplicates and backend outages without returning data',async()=>{
 await assert.rejects(createAdminEmployeeDirectory({
  readTimeclockEmployees:async()=>[...records,records[0]]
 }).list(),e=>e.status===503);
 await assert.rejects(createAdminEmployeeDirectory({
  readTimeclockEmployees:async()=>[{id:901,name:'Fixture',active:'yes'}]
 }).list(),e=>e.status===503);
 await assert.rejects(createAdminEmployeeDirectory({
  readTimeclockEmployees:async()=>{throw Error('private connection detail')}
 }).list(),e=>e.status===503&&!e.message.includes('private'));
 assert.throws(()=>createAdminEmployeeDirectory(),TypeError);
});
test('onboarding-only permission cannot enumerate directory or private records',async()=>{
 let operations=['admin.read','employees.onboard'];
 const access={authorize:async({operation})=>{
  if(!operations.includes(operation))throw Object.assign(new Error('denied'),{status:403});
  return {employeeId:'902',method:'passkey'};
 }};
 const app=express();
 app.use('/admin',createEmployeeAdminRouter({adminAccess:access,employeeDirectory:directory}));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const url='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(url+'/admin/api/employees')).status,403);
  assert.equal((await fetch(url+'/admin/api/employees?scope=private')).status,403);
  operations.push('employees.directory.read');
  const response=await fetch(url+'/admin/api/employees');
  assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/no-store/);
  const safe=await response.json();
  assert.equal(safe.employees.length,2);
  assert.deepEqual(Object.keys(safe.employees[0]).sort(),['active','id','name']);
  assert.equal((await fetch(url+'/admin/api/employees?scope=private')).status,403);
  assert.equal((await fetch(url+'/admin/api/employees?scope=full')).status,400);
  operations.push('employees.private.read');
  const privateResponse=await fetch(url+'/admin/api/employees?scope=private');
  assert.equal(privateResponse.status,200);
  assert.equal((await privateResponse.json()).employees[0].hasPin,true);
  assert.equal((await fetch(url+'/admin/api/employees',{method:'POST'})).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('without adapter there is no employee directory route at all',async()=>{
 const app=express();
 app.use('/admin',createEmployeeAdminRouter({
  adminAccess:{authorize:async()=>({employeeId:'901'})}
 }));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/admin/api/employees')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
