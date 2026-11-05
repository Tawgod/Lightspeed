import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecurityStagingApp} from '../staging/staff-security-server.js';
import {createIsolatedTestLoginMount} from '../staging/isolated-test-login.js';
import {hashIsolatedTestPin} from '../staging/isolated-test-identity.js';
import {migrateIsolatedTestLogin} from '../staging/migrate-isolated-test-login.js';

const env={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
 HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
 HC_STAGING_TEST_LOGIN_ENABLED:'true',
 HC_STAGING_PIN_STORE_MODE:'database',HC_STAGING_PIN_SETUP_ENABLED:'false',
 HC_STAGING_PUBLIC_ORIGIN:'https://staff-security-staging-test.up.railway.app',
 HC_STAGING_OWNER_PASSKEY_ENABLED:'true',
 HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'true',
 HC_STAGING_OWNER_BOOTSTRAP_KEY:'TEST-only-out-of-band-Owner-ceremony-key-value_1234567890',
 HC_STAGING_PASSKEY_SIGNING_SECRET:'test-only-passkey-signed-proofs-not-for-prod-abcdefghi',
 HC_STAGING_SESSION_SECRET:'test-only-session-secret-not-for-prod-abcd1234',
 HC_STAGING_THROTTLE_SECRET:'test-only-throttle-secret-not-for-prod-12345678',
 DATABASE_URL:'postgresql://user:password@postgres.railway.internal:5432/test'
};
const pinHash=hashIsolatedTestPin('4567',Buffer.alloc(16,7));
function pool(){
 return {
  connect:async()=>({
   query:async()=>({rows:[],rowCount:0}),
   release(){}
  }),
  query:async sql=>{
   if(sql.includes('SELECT pin_hash FROM hc_staging_pin_setup'))return {rows:[{pin_hash:pinHash}],rowCount:1};
   return {rows:[],rowCount:0};
  }
 };
}
test('Owner passkey test routes are disabled until explicit isolated flag',async()=>{
 const cfg={...env,HC_STAGING_OWNER_PASSKEY_ENABLED:'false',HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'false'};
 const login=createIsolatedTestLoginMount({environment:cfg,pool:pool()});
 const app=createSecurityStagingApp({environment:cfg,mountSecurity:login.mount});
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s))});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/test-login')).status,200);
  assert.notEqual((await fetch(base+'/test-owner-passkey')).status,200);
  assert.equal((await fetch(base+'/staff-passkey/')).status,503);
 }finally{await new Promise(ok=>server.close(ok))}
});
test('first Owner passkey static page serves only in staging and rejects PIN-only registration',async()=>{
 const login=createIsolatedTestLoginMount({environment:env,pool:pool()});
 const app=createSecurityStagingApp({environment:env,mountSecurity:login.mount});
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s))});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const page=await fetch(base+'/test-owner-passkey');
  assert.equal(page.status,200);
  assert.match(await page.text(),/Owner bootstrap key/);
  assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  const js=await fetch(base+'/staff-passkey/client.js');
  assert.equal(js.status,200);
  assert.match(await js.text(),/X-HC-Owner-Bootstrap-Key/);
  const unauth=await fetch(base+'/staff-passkey/registration/options',{
   method:'POST',headers:{'Content-Type':'application/json','Origin':env.HC_STAGING_PUBLIC_ORIGIN},
   body:'{}'
  });
  assert.equal(unauth.status,403);
  assert.equal((await fetch(base+'/staff-security')).status,503);
  assert.equal((await fetch(base+'/staff-enrollment-invites/bot/issue')).status,503);
 }finally{await new Promise(ok=>server.close(ok))}
});
test('staging Owner passkey startup requires separate strong signing and bootstrap secrets',()=>{
 const store=pool();
 for(const delta of [
  {HC_STAGING_PIN_SETUP_ENABLED:'true'},
  {HC_STAGING_PIN_STORE_MODE:'legacy-env'},
  {HC_STAGING_OWNER_BOOTSTRAP_KEY:'invalid'},
  {HC_STAGING_PASSKEY_SIGNING_SECRET:'short'},
  {HC_STAGING_TEST_OWNER_DISCORD_ID:'99999999999999999'},
  {NODE_ENV:'production'}
 ])assert.throws(()=>createIsolatedTestLoginMount({environment:{...env,...delta},pool:store}));
});
test('isolated Owner passkey migration is opt-in, transactional and includes append-only audit',async()=>{
 const queries=[],client={query:async q=>{queries.push(q)},end:async()=>{}};
 await migrateIsolatedTestLogin({
  environment:env,
  connect:async()=>client,
  loadSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staff_auth_throttle(x INTEGER);',
  loadSetupSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staging_pin_setup(x INTEGER);',
  loadPasskeySchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staff_passkeys(x INTEGER);',
  loadOwnerBootstrapSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staging_owner_passkey_bootstrap(x INTEGER);'
 });
 assert.equal(queries.filter(q=>q.startsWith('CREATE TABLE')).length,4);
 assert.equal(queries.at(0),'BEGIN');
 assert.equal(queries.at(-1),'COMMIT');
});

test('retiring first-Owner bootstrap key preserves existing passkey verification routes and denies new registration',async()=>{
 const cfg={...env,HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'false'};
 delete cfg.HC_STAGING_OWNER_BOOTSTRAP_KEY;
 const login=createIsolatedTestLoginMount({environment:cfg,pool:pool()});
 const app=createSecurityStagingApp({environment:cfg,mountSecurity:login.mount});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const page=await fetch(base+'/test-owner-passkey');
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Verify your existing Owner passkey/);
  assert.match(html,/data-owner-pilot-mode="verify-only"/);
  assert.doesNotMatch(html,/id="bootstrapKey"/);
  assert.equal((await fetch(base+'/staff-passkey/client.js')).status,200);
  const missingProof=await fetch(base+'/staff-passkey/authentication/options',{
   method:'POST',headers:{'Content-Type':'application/json','Origin':cfg.HC_STAGING_PUBLIC_ORIGIN},
   body:'{}'
  });
  assert.equal(missingProof.status,403,'the passkey verifier remains mounted but requires a signed session');
  const unauthorized=await fetch(base+'/staff-passkey/registration/options',{
   method:'POST',headers:{'Content-Type':'application/json','Origin':cfg.HC_STAGING_PUBLIC_ORIGIN},
   body:'{}'
  });
  assert.equal(unauthorized.status,403);
  assert.equal((await fetch(base+'/staff-enrollment-invites/bot/issue')).status,503);
  assert.equal((await fetch(base+'/staff-security/')).status,503);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
