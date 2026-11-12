import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOwnerLockedPreviewEnv,prepareLockedOwnerPreview} from '../staging/owner-locked-preview.js';
const pass=i=>String.fromCharCode(65+i).repeat(48);
const env=()=>({
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 RAILWAY_PROJECT_ID:'5b46096d-3178-47ec-ba88-d5037696346a',
 RAILWAY_ENVIRONMENT_ID:'46b93c76-3085-4e76-a37d-90dfdd250dd2',
 RAILWAY_SERVICE_NAME:'hc-owner-staging',HC_OWNER_STAGING_ENABLED:'false',
 HC_STAGING_TEST_LOGIN_ENABLED:'false',HC_STAGING_PIN_SETUP_ENABLED:'false',
 HC_OWNER_STAGING_ORIGIN:'https://hc-owner-staging-staging.up.railway.app',
 HC_OWNER_STAGING_RPID:'hc-owner-staging-staging.up.railway.app',
 HC_OWNER_STAGING_DATABASE_URL:'postgresql://hc_owner_stage_runtime:'+pass(0)+
  '@postgres-x8ui.railway.internal:5432/hc_owner_stage_test',
 HC_OWNER_SESSION_SECRET:pass(1),HC_OWNER_THROTTLE_SECRET:pass(2),
 HC_OWNER_PASSKEY_SIGNING_SECRET:pass(3),HC_OWNER_APPROVAL_HMAC_SECRET:pass(4),
 HC_OWNER_MFA_SESSION_SECRET:pass(5),HC_OWNER_TIMECLOCK_SERVICE_SECRET:pass(6),
 HC_OWNER_TOTP_ENCRYPTION_KEY:'A'.repeat(43)+'='
});
test('locked preview requires exact staging project and independent credentials',()=>{
 assert.equal(validateOwnerLockedPreviewEnv(env()).dbUrl,env().HC_OWNER_STAGING_DATABASE_URL);
 for(const bad of [{NODE_ENV:'production'},{HC_OWNER_STAGING_ENABLED:'true'},
  {HC_STAGING_TEST_LOGIN_ENABLED:'true'},
  {RAILWAY_PROJECT_ID:'production'},
  {HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'42'},
  {HC_OWNER_OPERATOR_DATABASE_URL:'postgres://danger'},
  {HC_OWNER_STAGING_RPID:'timcorp-projects.com'},
  {HC_OWNER_SESSION_SECRET:pass(2)},
  {HC_OWNER_TOTP_ENCRYPTION_KEY:'A'.repeat(44)},
  {HC_OWNER_STAGING_DATABASE_URL:env().HC_OWNER_STAGING_DATABASE_URL.replace('hc_owner_stage_runtime','postgres')}
 ])assert.throws(()=>validateOwnerLockedPreviewEnv({...env(),...bad}));
});
test('locked staging service serves only informational page; never accepts PIN/passkey',async()=>{
 let closed=false;
 const created=await prepareLockedOwnerPreview({environment:env(),
  createPool:()=>({end:async()=>{closed=true}}),verify:async()=>({ready:true})});
 const server=await new Promise(resolve=>{
  const s=created.app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  const h=await fetch(origin+'/health');
  assert.deepEqual(await h.json(),{service:'owner-security-staging',ready:false,locked:true});
  const ui=await fetch(origin+'/owner-setup/');
  assert.equal(ui.status,200);assert.match(await ui.text(),/not enabled/);
  const login=await fetch(origin+'/api/staff-auth/session',{method:'POST',
   headers:{'content-type':'application/json'},body:JSON.stringify({pin:'0000'})});
  assert.equal(login.status,423);
  const auth=await fetch(origin+'/staff-passkey/authentication/options',{method:'POST'});
  assert.equal(auth.status,423);
  assert.equal((await fetch(origin+'/unknown')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));await created.close()}
 assert.equal(closed,true);
});
