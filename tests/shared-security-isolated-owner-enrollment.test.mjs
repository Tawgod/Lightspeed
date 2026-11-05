import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createIsolatedOwnerEnrollmentMount,assertIsolatedOwnerEnrollmentConfiguration} from '../staging/isolated-owner-enrollment.js';
import {migrateIsolatedTestLogin} from '../staging/migrate-isolated-test-login.js';

const secret=n=>'test-only-independent-'+n+'-key-2026-ABCDEF1234567890';
const origin='https://staff-security-staging-test.up.railway.app';
const environment={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
 HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
 HC_STAGING_PUBLIC_ORIGIN:origin,
 HC_STAGING_TEST_LOGIN_ENABLED:'true',HC_STAGING_PIN_STORE_MODE:'database',
 HC_STAGING_PIN_SETUP_ENABLED:'false',
 HC_STAGING_OWNER_PASSKEY_ENABLED:'true',HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'false',
 HC_STAGING_OWNER_BOOTSTRAP_KEY:'',
 HC_STAGING_OWNER_APPROVAL_ENABLED:'true',HC_STAGING_OWNER_ENROLLMENT_ENABLED:'true',
 HC_STAGING_SESSION_SECRET:secret('session'),HC_STAGING_THROTTLE_SECRET:secret('throttle'),
 HC_STAGING_PASSKEY_SIGNING_SECRET:secret('passkey'),
 HC_STAGING_APPROVAL_HMAC_SECRET:secret('approval'),
 HC_STAGING_MFA_SESSION_SECRET:secret('mfa'),
 HC_STAGING_INVITE_BOT_SECRET:secret('bot'),
 HC_STAGING_INVITE_TOKEN_SECRET:secret('invitation'),
 HC_STAGING_TOTP_ENCRYPTION_KEY:Buffer.alloc(32,23).toString('base64'),
 DATABASE_URL:'postgresql://test_user:test_password@postgres.railway.internal:5432/railway'
};
function fakePool(){
 const calls=[];
 const pool={
   connect:async()=>({
     async query(sql){calls.push(sql);return {rowCount:0,rows:[]};},
     release(){}
   }),
   async query(sql){calls.push(sql);return {rowCount:0,rows:[]}}
 };
 return {pool,calls};
}
function composition(overrides={}){
 const {pool,calls}=fakePool();
 return {environment,pool,
   staffAuthGateway:{verifyBoundEmployee:async()=>{throw Error('Missing staff session')}},
   identity:{resolveDiscordEmployee:async()=>null,canInvite:async()=>false},
   passkeys:{verifyStrongManager:async()=>{throw Error('Independent passkey required')}},
   calls,...overrides};
}
test('isolated Owner enrollment cannot activate under missing or shared secrets, bootstrap, production or wrong host',()=>{
 assert.equal(assertIsolatedOwnerEnrollmentConfiguration(environment),true);
 for(const change of [
  {NODE_ENV:'production'},{HC_SECURITY_ENV:'production'},
  {HC_STAGING_TEST_OWNER_DISCORD_ID:'215626919134887940'},
  {HC_STAGING_TEST_GUILD_ID:'2485804234753573066'},
  {HC_STAGING_PUBLIC_ORIGIN:'https://evil.example'},
  {HC_STAGING_PIN_STORE_MODE:'legacy-env'},
  {HC_STAGING_PIN_SETUP_ENABLED:'true'},
  {HC_STAGING_OWNER_PASSKEY_ENABLED:'false'},
  {HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'true'},
  {HC_STAGING_OWNER_BOOTSTRAP_KEY:secret('old-bootstrap')},
  {HC_STAGING_OWNER_APPROVAL_ENABLED:'false'},
  {HC_STAGING_OWNER_ENROLLMENT_ENABLED:'false'},
  {HC_STAGING_APPROVAL_HMAC_SECRET:'short'},
  {HC_STAGING_TOTP_ENCRYPTION_KEY:'not-a-valid-32-byte-key'},
  {HC_STAGING_INVITE_BOT_SECRET:environment.HC_STAGING_INVITE_TOKEN_SECRET}
 ])assert.throws(()=>assertIsolatedOwnerEnrollmentConfiguration({...environment,...change}));
 for(const changes of [
  {staffAuthGateway:null},{identity:null},{passkeys:null}
 ])assert.throws(()=>createIsolatedOwnerEnrollmentMount(composition(changes)));
});
test('new factor routes are composed only with trusted identity, proof, and distinct secrets; unauthenticated invite denied',async()=>{
 const cfg=composition(),result=createIsolatedOwnerEnrollmentMount(cfg);
 assert.equal(typeof result.settingsRouter,'function');
 assert.equal(typeof result.invitationRouter,'function');
 const app=express();
 app.use('/staff-security',result.settingsRouter);
 app.use('/staff-enrollment-invites',result.invitationRouter);
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s))});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const denied=await fetch(base+'/staff-enrollment-invites/bot/issue',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({
    guildId:'1485804234753573066',channelId:'1566905099429744700',
    actorDiscordId:'115626919134887940',targetDiscordId:'115626919134887940',roleIds:[]
   })
  });
  assert.equal(denied.status,403);
  assert.equal(cfg.calls.length,0,'no DB mutations for unsigned or unlinked bot requests');
 }finally{await new Promise(ok=>server.close(ok));}
});
test('isolated enrollment migration validates credentials before private database access and creates only approved schemas',async()=>{
 let connected=0;const sql=[],client={query:async q=>{sql.push(q)},end:async()=>{}};
 const args={
  environment,connect:async()=>{connected++;return client},
  loadSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staff_auth_throttle(x INTEGER);',
  loadSetupSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staging_pin_setup(x INTEGER);',
  loadPasskeySchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staff_passkeys(x INTEGER);',
  loadOwnerBootstrapSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staging_owner_passkey_bootstrap(x INTEGER);',
  loadApprovalSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staff_factor_approvals(x INTEGER);',
  loadTotpSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staff_totp(x INTEGER);',
  loadInviteSchema:async()=> 'CREATE TABLE IF NOT EXISTS hc_staff_security_invitations(x INTEGER);'
 };
 await assert.rejects(migrateIsolatedTestLogin({
   ...args,environment:{...environment,HC_STAGING_INVITE_TOKEN_SECRET:'short'}
 }));
 assert.equal(connected,0,'invalid secrets must fail before any DB connection');
 await migrateIsolatedTestLogin(args);
 assert.equal(connected,1);
 assert.equal(sql[0],'BEGIN');
 assert.equal(sql.at(-1),'COMMIT');
 assert.equal(sql.filter(x=>x.startsWith('CREATE TABLE')).length,7);
 for(const name of ['hc_staff_factor_approvals','hc_staff_totp','hc_staff_security_invitations'])
   assert.ok(sql.some(x=>x.includes(name)));
});
