import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecurityStagingApp} from '../staging/staff-security-server.js';
import {createIsolatedTestLoginMount} from '../staging/isolated-test-login.js';
const env={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
 HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
 HC_STAGING_TEST_LOGIN_ENABLED:'true',
 HC_STAGING_PIN_STORE_MODE:'database',HC_STAGING_PIN_SETUP_ENABLED:'false',
 HC_STAGING_PUBLIC_ORIGIN:'https://staff-security-staging-test.up.railway.app',
 HC_STAGING_SESSION_SECRET:'test-only-staging-session-secret-1234567890',
 HC_STAGING_THROTTLE_SECRET:'test-only-throttle-hmac-secret-1234567890',
 HC_STAGING_OWNER_PASSKEY_ENABLED:'false',
 HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'false',
 HC_STAGING_OWNER_APPROVAL_ENABLED:'false',
 HC_STAGING_OWNER_ENROLLMENT_ENABLED:'false'
};
const pool={
 async connect(){return {async query(){throw Error('Unexpected test database use')},release(){}}},
 async query(){throw Error('Unexpected test database use')}
};
async function serve(config){
 const mounted=createIsolatedTestLoginMount({environment:config,pool});
 const app=createSecurityStagingApp({environment:config,mountSecurity:mounted.mount});
 return new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
}
async function verifyClosed(config,expectPasskeyPage=false){
 const server=await serve(config);
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const endpoints=[
   {path:'/test-owner-passkey',method:'GET',status:expectPasskeyPage?200:503},
   {path:'/staff-security',method:'GET',status:503},
   {path:'/staff-security/api/enrollment-approve',method:'POST',status:503},
   {path:'/staff-enrollment-invites/bot/issue',method:'POST',status:503},
   {path:'/api/test-pin-setup/set',method:'POST',status:503}
  ];
  for(const e of endpoints){
   const res=await fetch(base+e.path,{method:e.method});
   assert.equal(res.status,e.status,e.method+' '+e.path);
   if(expectPasskeyPage&&e.path==='/test-owner-passkey'){
     const html=await res.text();
     assert.match(html,/data-owner-pilot-mode="verify-only"/);
     assert.doesNotMatch(html,/id="bootstrapKey"/);
   }
  }
  const health=await fetch(base+'/health');
  assert.equal(health.status,200);
  assert.equal((await health.json()).ready,true);
 }finally{await new Promise(resolve=>server.close(resolve));}
}
test('approval flag alone cannot expose passkey, manager approval, invitation or QR APIs',async()=>{
 await verifyClosed({...env,HC_STAGING_OWNER_APPROVAL_ENABLED:'true'});
});
test('disabled passkey verifier refuses standalone bootstrap and enrollment toggles',()=>{
 for(const changed of [
  {HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'true'},
  {HC_STAGING_OWNER_ENROLLMENT_ENABLED:'true'},
  {HC_STAGING_OWNER_PASSKEY_ENABLED:'true',HC_STAGING_PASSKEY_SIGNING_SECRET:'short'}
 ])assert.throws(()=>createIsolatedTestLoginMount({
  environment:{...env,...changed},pool
 }));
});
test('enabling passkey verification alone still keeps every enrollment API unavailable',async()=>{
 const config={...env,
  HC_STAGING_OWNER_PASSKEY_ENABLED:'true',
  HC_STAGING_OWNER_APPROVAL_ENABLED:'true',
  HC_STAGING_PASSKEY_SIGNING_SECRET:'test-only-independent-passkey-signature-secret-1234'
 };
 await verifyClosed(config,true);
});
test('a first Owner bootstrap requires its own independent key and exact origin',()=>{
 for(const change of [
  {HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'true',HC_STAGING_OWNER_BOOTSTRAP_KEY:''},
  {HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'true',HC_STAGING_OWNER_BOOTSTRAP_KEY:'short'},
  {HC_STAGING_PUBLIC_ORIGIN:'https://other.example'}
 ]){
  assert.throws(()=>createIsolatedTestLoginMount({
    environment:{...env,
     HC_STAGING_OWNER_PASSKEY_ENABLED:'true',
     HC_STAGING_PASSKEY_SIGNING_SECRET:'test-only-independent-passkey-signature-secret-1234',
     ...change},pool
  }));
 }
});
