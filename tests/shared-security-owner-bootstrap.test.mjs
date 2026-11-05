import test from 'node:test';
import assert from 'node:assert/strict';
import {createIsolatedFirstOwnerPasskeyGrant} from '../staging/isolated-owner-passkey-grant.js';
const key='unit-test-EXTERNAL-INDEPENDENT-BOOTSTRAP-credential_2026-123456';
const origin='https://staff-security-staging-test.up.railway.app';
const env={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
 HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
 HC_STAGING_TEST_LOGIN_ENABLED:'true',
 HC_STAGING_PIN_STORE_MODE:'database',HC_STAGING_PIN_SETUP_ENABLED:'false',
 HC_STAGING_OWNER_PASSKEY_ENABLED:'true',HC_STAGING_PUBLIC_ORIGIN:origin,
 HC_STAGING_OWNER_BOOTSTRAP_KEY:key
};
const now=Date.parse('2026-11-04T18:00:00Z');
const signedOwner={id:'901',active:true,binding:'unit-signed-session-binding_2345',expiresAtMs:now+900000};
const context=(overrides={})=>({
 get(name){return ({origin,'x-hc-owner-bootstrap-key':key,'sec-fetch-site':'same-origin',...overrides})[name.toLowerCase()]||null;}
});
function createDb(){
 const row={started_at:null,consumed_at:null,expires_at:null},events=[],otherPasskeys=[];
 const queries=[];
 const client={
  async query(sql,args=[]){
   queries.push(sql);
   if(sql.includes('WITH activated AS')){
    if(row.started_at||row.consumed_at)return {rows:[],rowCount:0};
    row.started_at=new Date(now);
    row.expires_at=new Date(now+4*3600000);
    events.push([args[0],args[1],null,'started']);
    return {rows:[{event_id:args[0]}],rowCount:1};
   }
   if(sql.includes('FROM hc_staging_owner_passkey_bootstrap')&&sql.includes('FOR UPDATE'))return {rows:[{...row}],rowCount:1};
   if(sql.includes('FROM hc_staff_passkeys'))return {rows:otherPasskeys,rowCount:otherPasskeys.length};
   if(sql.startsWith('UPDATE hc_staging_owner_passkey_bootstrap')){
    if(row.consumed_at)return {rowCount:0,rows:[]};
    row.consumed_at=new Date(now);return {rowCount:1,rows:[{id:1}]};
   }
   if(sql.startsWith('INSERT INTO hc_staging_owner_passkey_bootstrap_events')){
    events.push(args);return {rowCount:1};
   }
   if(sql.includes('FROM hc_staging_owner_passkey_bootstrap'))return {rows:[{...row}],rowCount:1};
   throw Error('Unexpected query: '+sql);
  }
 };
 return {pool:{query:(...args)=>client.query(...args)},client,row,events,otherPasskeys,queries};
}
test('first Owner passkey bootstrap requires exact staging, persisted PIN and independent secret',()=>{
 const {pool}=createDb();
 const opts={environment:env,pool,verifyBoundEmployee:async()=>signedOwner,now:()=>now};
 assert.ok(createIsolatedFirstOwnerPasskeyGrant(opts));
 for(const change of [
  {NODE_ENV:'production'}, {HC_SECURITY_ENV:'production'},
  {HC_STAGING_TEST_OWNER_DISCORD_ID:'215626919134887940'},
  {HC_STAGING_TEST_GUILD_ID:'2485804234753573066'},
  {HC_STAGING_PIN_STORE_MODE:'legacy-env'},
  {HC_STAGING_PIN_SETUP_ENABLED:'true'},
  {HC_STAGING_OWNER_PASSKEY_ENABLED:'false'},
  {HC_STAGING_OWNER_BOOTSTRAP_KEY:'short'},
  {HC_STAGING_PUBLIC_ORIGIN:'https://evil.example'}
 ])assert.throws(()=>createIsolatedFirstOwnerPasskeyGrant({...opts,environment:{...env,...change}}));
});
test('forged origins, mismatched owner, missing proof and expired grants are denied',async()=>{
 const db=createDb(),opts={environment:env,pool:db.pool,now:()=>now};
 const valid={context:context(),employeeId:'901',phase:'begin'};
 const own=createIsolatedFirstOwnerPasskeyGrant({...opts,verifyBoundEmployee:async()=>signedOwner});
 assert.equal(await own.authorizeRegistration(valid),true);
 for(const bad of [
  {...valid,context:context({origin:'https://evil.example'})},
  {...valid,context:context({'x-hc-owner-bootstrap-key':'wrong'})},
  {...valid,context:context({'sec-fetch-site':'cross-site'})},
  {...valid,employeeId:'902'},
  {...valid,phase:'change'}
 ])await assert.rejects(own.authorizeRegistration(bad));
 const wrong=createIsolatedFirstOwnerPasskeyGrant({...opts,verifyBoundEmployee:async()=>({...signedOwner,id:'902'})});
 await assert.rejects(wrong.authorizeRegistration(valid));
 const stale=createIsolatedFirstOwnerPasskeyGrant({...opts,verifyBoundEmployee:async()=>({...signedOwner,expiresAtMs:now-1})});
 await assert.rejects(stale.authorizeRegistration(valid));
 db.row.expires_at=new Date(now-1);
 await assert.rejects(own.authorizeRegistration(valid));
});
test('one real approved registration can consume bootstrap exactly once, with audit',async()=>{
 const db=createDb();
 const grant=createIsolatedFirstOwnerPasskeyGrant({
  environment:env,pool:db.pool,verifyBoundEmployee:async()=>signedOwner,now:()=>now
 });
 const g={context:context(),employeeId:'901',phase:'begin'};
 assert.equal(await grant.authorizeRegistration(g),true);
 assert.equal(await grant.authorizeRegistration({...g,phase:'complete'}),true);
 await grant.commitRegistrationGrant({
  context:context(),employeeId:'901',credentialId:'abc-valid-webauthn-public-credential',client:db.client
 });
 assert.ok(db.row.consumed_at);
 assert.equal(db.events.length,2);
 assert.equal(db.events[0][3],'started');
 assert.equal(db.events[1][3],'completed');
 assert.equal(db.events[1][1],'901');
 await assert.rejects(grant.authorizeRegistration(g));
 await assert.rejects(grant.commitRegistrationGrant({
  context:context(),employeeId:'901',credentialId:'other-credential',client:db.client
 }));
 assert.equal(db.events.length,2);
});
test('second active passkey and wrong credential owner are never bootstrap-granted',async()=>{
 const db=createDb(),grant=createIsolatedFirstOwnerPasskeyGrant({
  environment:env,pool:db.pool,verifyBoundEmployee:async()=>signedOwner,now:()=>now
 });
 db.otherPasskeys.push({id:1});
 await assert.rejects(grant.authorizeRegistration({context:context(),employeeId:'901',phase:'begin'}));
 await assert.rejects(grant.commitRegistrationGrant({
   context:context(),employeeId:'901',credentialId:'new-credential',client:db.client
 }));
 assert.equal(db.row.consumed_at,null);
 assert.equal(db.events.length,0);
});

test('window starts only when authorized Owner begins and never resets on completion, expiry or replay',async()=>{
 const db=createDb(),grant=createIsolatedFirstOwnerPasskeyGrant({
  environment:env,pool:db.pool,verifyBoundEmployee:async()=>signedOwner,now:()=>now
 });
 const auth={context:context(),employeeId:'901'};
 await assert.rejects(grant.authorizeRegistration({...auth,phase:'complete'}));
 assert.equal(db.row.started_at,null);
 assert.equal(db.events.length,0);
 await grant.authorizeRegistration({...auth,phase:'begin'});
 const initialStart=db.row.started_at.getTime(),expiry=db.row.expires_at.getTime();
 assert.equal(expiry-initialStart,4*3600000);
 assert.equal(db.events.length,1);
 await grant.authorizeRegistration({...auth,phase:'begin'});
 assert.equal(db.row.started_at.getTime(),initialStart);
 assert.equal(db.events.length,1,'duplicate begins must not append another audit event');
 db.row.expires_at=new Date(now-1);
 await assert.rejects(grant.authorizeRegistration({...auth,phase:'begin'}));
 assert.equal(db.events.length,1,'expired window cannot be reopened by an old key');
 assert.equal(db.row.started_at.getTime(),initialStart);
 db.row.expires_at=new Date(expiry);
 db.row.consumed_at=new Date(now);
 await assert.rejects(grant.authorizeRegistration({...auth,phase:'begin'}));
 assert.equal(db.events.length,1,'consumed grant must never be reset');
});
