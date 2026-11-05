import test from 'node:test';
import assert from 'node:assert/strict';
import {launchSecurityStaging,checkIsolatedPasskeyConfiguration} from '../staging/staff-security-server.js';
const env={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_TEST_LOGIN_ENABLED:'true',
 HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
 HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
 DATABASE_URL:'postgresql://u:p@postgres.railway.internal:5432/test'
};
test('disabled-by-default health startup does not touch database',async()=>{
 let migrations=0,started=0;
 const res=await launchSecurityStaging({
  environment:{...env,HC_STAGING_TEST_LOGIN_ENABLED:'false'},
  migrate:async()=>{migrations++},
  start:()=>{started++;return 'ready'}
 });
 assert.equal(res,'ready');assert.equal(migrations,0);assert.equal(started,1);
});
test('private schema must be ready before opening a test login port',async()=>{
 const phases=[],env2={...env};
 const res=await launchSecurityStaging({
  environment:env2,
  migrate:async()=>{phases.push('migrate');if(phases.length===1)throw Error('not ready')},
  pause:async()=>{phases.push('pause')},
  start:()=>{phases.push('listen');return 'started'}
 });
 assert.equal(res,'started');
 assert.deepEqual(phases,['migrate','pause','migrate','listen']);
});
test('wrong database boundary never runs migration, or starts a listening port',async()=>{
 for(const change of [{NODE_ENV:'production'}, {DATABASE_URL:'postgresql://u:p@prod.example.com:5432/test'}]){
  let called=false;
  await assert.rejects(launchSecurityStaging({
   environment:{...env,...change},
   migrate:async()=>{called=true;},
   start:()=>{called=true;throw Error('should not start')}
  }));
  assert.equal(called,false);
 }
});
test('after repeated schema failures service never opens a socket',async()=>{
 let attempts=0,starts=0,pauses=0;
 await assert.rejects(launchSecurityStaging({
  environment:env,
  migrate:async()=>{attempts++;throw Error('db down')},
  pause:async()=>{pauses++},
  start:()=>{starts++;return null}
 }),/database migration could not become ready/);
 assert.equal(attempts,20);assert.equal(pauses,19);assert.equal(starts,0);
});

test('first Owner bootstrap rejects missing independent key before creating an expiring grant',async()=>{
 const ready={
  ...env,HC_STAGING_OWNER_PASSKEY_ENABLED:'true',
 HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'true',
  HC_STAGING_PIN_STORE_MODE:'database',
  HC_STAGING_PIN_SETUP_ENABLED:'false',
  HC_STAGING_PUBLIC_ORIGIN:'https://staff-security-staging-test.up.railway.app',
  HC_STAGING_OWNER_BOOTSTRAP_KEY:'test-only-out-of-band-owner-key-1234567890abcdef123456',
  HC_STAGING_PASSKEY_SIGNING_SECRET:'test-only-independent-passkey-signing-1234567890'
 };
 for(const change of [
  {HC_STAGING_OWNER_BOOTSTRAP_KEY:''},
  {HC_STAGING_PUBLIC_ORIGIN:'https://evil.example'},
  {HC_STAGING_PIN_SETUP_ENABLED:'true'},
  {HC_STAGING_PASSKEY_SIGNING_SECRET:'short'}
 ]){
  let migrated=0,started=0;
  await assert.rejects(launchSecurityStaging({
   environment:{...ready,...change},
   migrate:async()=>{migrated++},
   start:()=>{started++}
  }));
  assert.equal(migrated,0);
  assert.equal(started,0);
 }
});

test('first Owner bootstrap may be retired while WebAuthn signing remains enabled',async()=>{
 const cfg={
  ...env,HC_STAGING_OWNER_PASSKEY_ENABLED:'true',
  HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'false',
  HC_STAGING_PIN_STORE_MODE:'database',HC_STAGING_PIN_SETUP_ENABLED:'false',
  HC_STAGING_PUBLIC_ORIGIN:'https://staff-security-staging-test.up.railway.app',
  HC_STAGING_PASSKEY_SIGNING_SECRET:'test-only-independent-passkey-signing-1234567890'
 };
 delete cfg.HC_STAGING_OWNER_BOOTSTRAP_KEY;
 let migrated=0,started=0;
 await launchSecurityStaging({
  environment:cfg,migrate:async()=>{migrated++},
  start:()=>{started++;return 'started';}
 });
 assert.equal(migrated,1);
 assert.equal(started,1);
});

test('isolated preflight reports names only and never outputs secret values',async()=>{
 const secret='do-not-log-this-test-secret';
 const bootstrap='test-bootstrap-token_abcdefghijklmnopqrstuvwxyz0123456789';
 const config={...env,
   HC_STAGING_OWNER_PASSKEY_ENABLED:'true',
   HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'true',
   HC_STAGING_PIN_STORE_MODE:'database',
   HC_STAGING_PIN_SETUP_ENABLED:'false',
   HC_STAGING_PUBLIC_ORIGIN:'https://staff-security-staging-test.up.railway.app',
   HC_STAGING_PASSKEY_SIGNING_SECRET:'short',
   HC_STAGING_OWNER_BOOTSTRAP_KEY:secret,
   HC_STAGING_OWNER_ENROLLMENT_ENABLED:'true'
 };
 const problems=checkIsolatedPasskeyConfiguration(config);
 assert.deepEqual(problems,[
   'HC_STAGING_PASSKEY_SIGNING_SECRET',
   'HC_STAGING_OWNER_BOOTSTRAP_KEY',
   'HC_STAGING_OWNER_ENROLLMENT_ENABLED'
 ]);
 let migrated=0;
 await assert.rejects(launchSecurityStaging({
   environment:config,migrate:async()=>{migrated++},start:()=>{throw Error('no start')}
 }),error=>{
   assert.match(error.message,/HC_STAGING_OWNER_BOOTSTRAP_KEY/);
   assert.doesNotMatch(error.message,/do-not-log-this-test-secret|test-bootstrap-token/);
   return true;
 });
 assert.equal(migrated,0);
 assert.deepEqual(checkIsolatedPasskeyConfiguration({
   ...config,HC_STAGING_PASSKEY_SIGNING_SECRET:'test-only-independent-signing-secret-123456',
   HC_STAGING_OWNER_BOOTSTRAP_KEY:bootstrap,
   HC_STAGING_OWNER_ENROLLMENT_ENABLED:'false'
 }),[]);
});
