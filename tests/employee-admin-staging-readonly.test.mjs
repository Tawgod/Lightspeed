import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createIsolatedAdminReadonlyMount} from '../staging/isolated-admin-readonly.js';

const env={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_ADMIN_READONLY_ENABLED:'true',
 HC_STAGING_TEST_LOGIN_ENABLED:'true',
 HC_STAGING_OWNER_PASSKEY_ENABLED:'true',
 HC_STAGING_OWNER_ENROLLMENT_ENABLED:'true',
 HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'false',
 HC_STAGING_PUBLIC_ORIGIN:'https://staff-security-staging-test.up.railway.app'
};
const now=2000000000000;
const gateway={verifyBoundEmployee:async req=>{
 if(req.get('authorization')!=='Bearer signed-synthetic')throw Error('Missing signed base session');
 return {
  employeeId:'901',id:'901',active:true,
  permissionSource:'synthetic_staging_only',
  binding:'bound-synthetic-session-901',expiresAtMs:now+900000
 };
}};
const passkeys={verifyStrongManager:async req=>{
 if(req.get('x-hc-passkey-proof')!=='signed-passkey-proof')throw Error('Passkey not accepted');
 return {verified:true,method:'passkey',employeeId:'901',authenticatedAtMs:now-1000};
}};
const enrollment={verifyTotpStepUp:async req=>{
 if(req.get('x-hc-mfa-session')!=='signed-totp-proof')throw Error('TOTP not accepted');
 return {verified:true,method:'totp',employeeId:'901',authenticatedAtMs:now-1000};
}};
const create=options=>createIsolatedAdminReadonlyMount({
 environment:env,gateway,passkeys,enrollment,now:()=>now,...options
});
test('isolated admin preview refuses missing opt-in and incomplete verified factor services',()=>{
 assert.throws(()=>create({environment:{...env,HC_STAGING_ADMIN_READONLY_ENABLED:'false'}}),TypeError);
 assert.throws(()=>create({environment:{...env,NODE_ENV:'production'}}),TypeError);
 assert.throws(()=>create({passkeys:null}),TypeError);
 assert.throws(()=>create({enrollment:null}),TypeError);
});
test('read-only admin requires bound employee plus strong factor, blocks writes and cross-origin',async()=>{
 const mounted=create();
 const app=express();
 app.use('/employee-admin',mounted.router);
 const server=await new Promise(resolve=>{
  const server=app.listen(0,'127.0.0.1',()=>resolve(server));
 });
 try{
  const root='http://127.0.0.1:'+server.address().port;
  const get=(path,headers)=>fetch(root+path,{headers});
  const base={authorization:'Bearer signed-synthetic'};
  const rejected=await get('/employee-admin/api/overview',base);
  assert.equal(rejected.status,403,'PIN-only/base-session access must fail');
  const totp={...base,'x-hc-mfa-session':'signed-totp-proof'};
  const admitted=await get('/employee-admin/api/overview',totp);
  assert.equal(admitted.status,200);
  const overview=await admitted.json();
  assert.equal(overview.employeeId,'901');
  assert.equal(overview.role,'owner');
  assert.equal(overview.authMethod,'totp');
  assert.equal(overview.configurationWritesEnabled,false);
  assert.equal(overview.delegatedGrantManagementEnabled,false);
  const list=await get('/employee-admin/api/settings',totp);
  assert.equal(list.status,200);
  assert.ok((await list.json()).items.some(x=>x.section==='Tool Settings'));
  const pk={...base,'x-hc-passkey-proof':'signed-passkey-proof'};
  assert.equal((await get('/employee-admin/api/overview',pk)).status,200);
  const cross=await get('/employee-admin/api/overview',{...pk,origin:'https://untrusted.example'});
  assert.equal(cross.status,403);
  const forged=await get('/employee-admin/api/overview',{
   ...base,'x-hc-owner':'true','x-employee-role':'owner','x-verified-device':'true'
  });
  assert.equal(forged.status,403);
  const mut=await fetch(root+'/employee-admin/api/admin-grants',{
   method:'POST',headers:{...pk,'content-type':'application/json'},
   body:JSON.stringify({targetEmployeeId:'902',operation:'admin.read',enabled:true,reason:'test only'})
  });
  assert.equal(mut.status,404);
  const html=await get('/employee-admin/');
  assert.equal(html.status,200);
  assert.match(await html.text(),/adminTestSignIn/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
