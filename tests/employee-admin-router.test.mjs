import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createEmployeeAdminRouter} from '../routes/employeeAdmin.js';

test('admin discovery only returns metadata behind independently verified staff and admin factor',async()=>{
 let admitted=false;
 let calls=[];
 const access={
  authorize:async({operation})=>{
   calls.push(operation);
   if(!admitted)throw Object.assign(new Error('denied'),{status:403});
   return {employeeId:'901',method:'totp'};
  }
 };
 assert.throws(()=>createEmployeeAdminRouter(),TypeError);
 const app=express();
 app.use('/admin',createEmployeeAdminRouter({adminAccess:access}));
 const listener=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const url='http://127.0.0.1:'+listener.address().port;
  const rejected=await fetch(url+'/admin/api/settings');
  assert.equal(rejected.status,403);
  assert.match(rejected.headers.get('cache-control'),/no-store/);
  admitted=true;
  const overview=await fetch(url+'/admin/api/overview');
  assert.equal(overview.status,200);
  const body=await overview.json();
  assert.equal(body.employeeId,'901');
  assert.equal(body.authMethod,'totp');
  assert.equal(body.configurationWritesEnabled,false);
  const listing=await fetch(url+'/admin/api/settings');
  assert.equal(listing.status,200);
  const settings=await listing.json();
  assert.equal(settings.readOnly,true);
  assert.ok(settings.items.some(x=>x.section==='Tool Settings'));
  const key=settings.items.find(x=>x.section==='Tool Settings').id;
  const detail=await fetch(url+'/admin/api/settings/'+key);
  assert.equal(detail.status,200);
  assert.equal((await detail.json()).item.id,key);
  const unknown=await fetch(url+'/admin/api/settings/not.real');
  assert.equal(unknown.status,404);
  const write=await fetch(url+'/admin/api/settings/'+key,{
   method:'PATCH',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({value:true})
  });
  assert.equal(write.status,404);
  assert.ok(calls.includes('admin.read'));
  assert.ok(calls.includes('tools.settings.read'));
 }finally{
  await new Promise(resolve=>listener.close(resolve));
 }
});
