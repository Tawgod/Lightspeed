import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createEmployeeAdminRouter} from '../routes/employeeAdmin.js';

test('delegated manager sees only allowed menu sections and non-sensitive tool settings metadata',async()=>{
 let role='delegated_admin';
 const delegations={
  capabilitiesForVerifiedEmployee:async()=>({
   role,operations:role==='owner'
    ?['admin.read','admin.delegation.manage','tools.settings.read','employees.private.read','permissions.manage']
    :['admin.read','employees.onboard','tools.settings.read','tools.settings.manage','permissions.manage'],
   grantScopes:['products.draft']
  }),
  listGrants:async()=>{throw Object.assign(new Error('denied'),{status:403})},
  changeAdminGrant:async()=>{throw Object.assign(new Error('denied'),{status:403})},
  changeGrantScope:async()=>{throw Object.assign(new Error('denied'),{status:403})},
  changeSettingScope:async()=>{throw Object.assign(new Error('denied'),{status:403})},
  changeEmployeeToolGrant:async()=>{throw Object.assign(new Error('denied'),{status:403})},
  listEmployeeToolGrants:async()=>{throw Object.assign(new Error('denied'),{status:403})}
 };
 const access={
  authorize:async({operation})=>{
   if(!['admin.read','tools.settings.read'].includes(operation))
    throw Object.assign(new Error('denied'),{status:403});
   return {employeeId:'902',method:'totp'};
  }
 };
 const app=express();
 app.use('/admin',createEmployeeAdminRouter({adminAccess:access,delegations}));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const url='http://127.0.0.1:'+server.address().port;
  const overview=await (await fetch(url+'/admin/api/overview')).json();
  assert.equal(overview.role,'delegated_admin');
  assert.equal(overview.sectionAccess.employeePrivate,false);
  assert.equal(overview.sectionAccess.timeclock,false);
  assert.equal(overview.sectionAccess.settings,true);
  assert.equal(overview.sectionAccess.permissions,true);
  assert.equal(overview.grantedOperations.includes('admin.delegation.manage'),false);
  const list=await (await fetch(url+'/admin/api/settings')).json();
  assert.ok(list.items.length>0);
  assert.ok(list.items.every(x=>x.section==='Tool Settings'));
  const forbidden=await fetch(url+'/admin/api/settings/employees.pin');
  assert.equal(forbidden.status,404);
  const missing=await fetch(url+'/admin/api/settings/security.factors');
  assert.equal(missing.status,404);
  const attempted=await fetch(url+'/admin/api/admin-grants',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({targetEmployeeId:'903',operation:'admin.read',enabled:true,reason:'Attempt escalation'})
  });
  assert.equal(attempted.status,403);
  role='owner';
  const owner=await (await fetch(url+'/admin/api/overview')).json();
  assert.equal(owner.role,'owner');
  assert.equal(owner.sectionAccess.employeePrivate,true);
  assert.equal(owner.sectionAccess.timeclock,true);
  const ownerList=await (await fetch(url+'/admin/api/settings')).json();
  assert.ok(ownerList.items.some(x=>x.section==='Employees'));
 }finally{await new Promise(resolve=>server.close(resolve));}
});
