import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {ADMIN_INTEGRATION_NAVIGATION,listAdminIntegrations} from '../services/security/adminIntegrationCatalog.js';
import {createEmployeeAdminRouter} from '../routes/employeeAdmin.js';

test('no admin navigation or integration data without exact grant',()=>{
 assert.equal(listAdminIntegrations({role:'delegated_admin',grantedOperations:[]}).length,0);
 assert.equal(ADMIN_INTEGRATION_NAVIGATION.adminRequires,'admin.read');
 const entries=listAdminIntegrations({role:'delegated_admin',grantedOperations:['admin.read','employees.onboard']});
 assert.equal(entries.length,10);
 assert.ok(entries.every(x=>x.requiresBackendAuthorization));
 assert.ok(entries.every(x=>x.permissionEnforcement==='not-integrated'));
 const admin=entries.find(x=>x.id==='employee-admin');
 assert.deepEqual(admin.operations,['admin.read','employees.onboard']);
 assert.equal(admin.showAdminLink,true);
 const so=entries.find(x=>x.id==='special-orders');
 const preorder=entries.find(x=>x.id==='preorders');
 assert.deepEqual(so.children,['preorders','ordering']);
 assert.deepEqual(preorder.children,['gw-preorders']);
 assert.equal(entries.find(x=>x.id==='consignment').state,'beta-not-integrated');
 assert.ok(!entries.some(x=>x.settingsAdapter==='connected'));
});
test('server-gated integration listing never grants access to raw employees',async()=>{
 let permitted=false,resolveCalls=0;
 const access={authorize:async({operation})=>{
  if(!permitted||operation!=='admin.read')throw Object.assign(new Error('denied'),{status:403});
  return {employeeId:'902',method:'totp'};
 }};
 const app=express();
 app.use('/employee-admin',createEmployeeAdminRouter({
  adminAccess:access,
  resolveCapabilities:async id=>{
   resolveCalls++;
   assert.equal(id,'902');
   return {employeeId:'902',role:'delegated_admin',operations:['admin.read','tools.settings.read']};
  }
 }));
 const srv=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 try{
  const uri='http://127.0.0.1:'+srv.address().port+'/employee-admin/api/integrations';
  const denied=await fetch(uri);
  assert.equal(denied.status,403);
  assert.equal(resolveCalls,0);
  permitted=true;
  const ok=await fetch(uri);
  assert.equal(ok.status,200);
  const body=await ok.json();
  assert.equal(body.configurationWritesEnabled,false);
  assert.equal(body.readOnly,true);
  assert.equal(body.items.length,10);
  assert.equal(body.items.find(x=>x.id==='employee-admin').operations.includes('admin.delegation.manage'),false);
  assert.equal(body.navigation.adminId,'employee-admin');
  assert.match(ok.headers.get('cache-control'),/no-store/);
  assert.equal((await fetch(uri,{method:'POST'})).status,404);
 }finally{await new Promise(resolve=>srv.close(resolve))}
});
