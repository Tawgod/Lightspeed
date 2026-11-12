import test from 'node:test';
import assert from 'node:assert/strict';
const base='https://hc-owner-staging-staging.up.railway.app';
async function req(path,method='GET',extra={}){
 const url=new URL(path,base);
 assert.equal(url.origin,base);
 const r=await fetch(url,{method,redirect:'manual',cache:'no-store',
  signal:AbortSignal.timeout(15000),...extra});
 return {r,body:await r.text()};
}
test('real isolated Owner staging health is locked, never sign-in-ready',async()=>{
 const {r,body}=await req('/health');
 assert.equal(r.status,200);
 assert.deepEqual(JSON.parse(body),{service:'owner-security-staging',ready:false,locked:true});
 assert.match(r.headers.get('cache-control')||'',/no-store/);
});
test('HTTPS Owner setup page has no sign-in form or token and is not cached',async()=>{
 const {r,body}=await req('/owner-setup/');
 assert.equal(r.status,200);
 assert.match(body,/Owner login setup/);
 assert.match(body,/not enabled/);
 assert.doesNotMatch(body,/<form|password|credential_id|activation_digest/i);
 assert.match(r.headers.get('content-security-policy')||'',/default-src 'none'/);
 assert.match(r.headers.get('cache-control')||'',/no-store/);
});
test('all candidate Owner/PIN/passkey operations refuse requests even with fake identity claims',async()=>{
 for(const path of ['/api/staff-auth/session','/staff-passkey/authentication/options',
  '/owner-setup/registration/options','/staff-security/factor/approve']){
  const {r,body}=await req(path,'POST',{headers:{
   'Content-Type':'application/json','x-hc-role':'owner',
   'authorization':'Bearer definitely-not-a-token'},
   body:JSON.stringify({pin:'0000',employeeId:'901'})});
  assert.equal(r.status,423,path);
  assert.match(body,/not enabled/);
 }
 const unknown=await req('/unknown-route');
 assert.equal(unknown.r.status,404);
});
