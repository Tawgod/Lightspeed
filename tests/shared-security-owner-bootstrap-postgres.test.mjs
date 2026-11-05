import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createStaffAuthGateway} from '../services/staffAuthGateway.js';
import {createPostgresStaffPasskeys} from '../services/security/staffPasskeysPostgres.js';
import {createIsolatedFirstOwnerPasskeyGrant} from '../staging/isolated-owner-passkey-grant.js';

const database=process.env.HC_TEST_DATABASE_URL;
const gated={skip:!database?'Requires disposable hc_test Postgres':false};
const origin='https://staff-security-staging-test.up.railway.app';
const owner='115626919134887940';
const guild='1485804234753573066';
const key='test-only-independent-owner-bootstrap-key-1234567890-ABCDEFG';
const env={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_TEST_OWNER_DISCORD_ID:owner,HC_STAGING_TEST_GUILD_ID:guild,
 HC_STAGING_TEST_LOGIN_ENABLED:'true',
 HC_STAGING_PIN_STORE_MODE:'database',HC_STAGING_PIN_SETUP_ENABLED:'false',
 HC_STAGING_OWNER_PASSKEY_ENABLED:'true',
 HC_STAGING_OWNER_BOOTSTRAP_ENABLED:'true',
 HC_STAGING_PUBLIC_ORIGIN:origin,HC_STAGING_OWNER_BOOTSTRAP_KEY:key
};
test('atomic verified first Owner WebAuthn registration rolls back a rejected independent grant',gated,async()=>{
 if(!/hc_test/.test(database))throw Error('Refusing non-disposable database');
 const pool=new pg.Pool({connectionString:database,max:4});
 const id=randomBytes(24).toString('base64url');
 const fakeEmployee={
  verifyPin:async pin=>{
   if(pin!=='4792')throw Error('Denied');
   return {id:901,name:'Test Only Owner'};
  },
  authorize:async id=>String(id)==='901'?{id:901,name:'Test Only Owner'}:null
 };
 const auth=createStaffAuthGateway({
  identity:fakeEmployee,sessionSecret:'test-owner-bootstrap-signed-session-secret-2026',
  loginLimiter:async()=>true
 });
 let currentKey=id;
 const webauthn={
  generateRegistrationOptions:async()=>({challenge:randomBytes(32).toString('base64url')}),
  verifyRegistrationResponse:async({expectedChallenge,expectedOrigin,expectedRPID})=>{
   assert.match(expectedChallenge,/^[A-Za-z0-9_-]+$/);
   assert.equal(expectedOrigin,origin);
   assert.equal(expectedRPID,'staff-security-staging-test.up.railway.app');
   return {verified:true,registrationInfo:{
    credential:{id:currentKey,publicKey:new Uint8Array(64),counter:0,transports:['internal']},
    credentialDeviceType:'multiDevice',credentialBackedUp:true
   }};
  },
  generateAuthenticationOptions:async()=>({challenge:randomBytes(32).toString('base64url')}),
  verifyAuthenticationResponse:async()=>({verified:false})
 };
 const signingSecret='test-owner-passkey-signing-hmac-secret-2026-ABC';
 try{
  for(const file of ['hc_staff_auth_throttle.sql','hc_staff_passkeys.sql',
    'hc_staging_owner_passkey_bootstrap.sql']){
   await pool.query(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  }
  const req={
   get:name=>{
    const headers={
     'origin':origin,'sec-fetch-site':'same-origin',
     'x-hc-owner-bootstrap-key':key
    };
    return headers[name.toLowerCase()]||null;
   }
  };
  // Sign a legitimate synthetic session without posting a test PIN or session
  // token into logs, GitHub or an external application.
  const login={
   get(name){return name.toLowerCase()==='authorization'?
     'Bearer '+token:req.get(name);}
  };
  // Staff auth router's factory offers no public token issuance method, so
  // use local loopback HTTP to exercise its actual signed PIN login.
  const express=(await import('express')).default;
  const app=express();app.use('/api/staff-auth',auth.router);
  const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s))});
  let token;
  try{
   const resp=await fetch('http://127.0.0.1:'+server.address().port+'/api/staff-auth/session',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'4792'})
   });
   assert.equal(resp.status,200);
   token=(await resp.json()).token;
  }finally{await new Promise(ok=>server.close(ok))}
  const grant=createIsolatedFirstOwnerPasskeyGrant({
   environment:env,pool,verifyBoundEmployee:auth.verifyBoundEmployee
  });
  const make=commitRegistrationGrant=>createPostgresStaffPasskeys({
   pool,origin,rpID:'staff-security-staging-test.up.railway.app',
   signingSecret,verifyBoundEmployee:auth.verifyBoundEmployee,
   authorizeRegistration:grant.authorizeRegistration,
   commitRegistrationGrant,verifyStrongManager:async()=>{throw Error('No fallback');},
   canManage:async()=>false,loginThrottle:{reserve:async()=>true},
   webauthn
  });
  const initial=await pool.query('SELECT started_at,expires_at FROM hc_staging_owner_passkey_bootstrap WHERE id=1');
  assert.equal(initial.rows[0].started_at,null,'deploy migration must not begin Owner grant expiry');
  assert.equal(initial.rows[0].expires_at,null,'four-hour window begins only at an approved ceremony');
  const fail=make(async()=>{throw Object.assign(Error('Rejected'),{code:'HC_PASSKEY_DENIED'})});
  const beginning=await fail.beginRegistration({context:login,sourceIp:'127.0.0.1'});
  const started=await pool.query('SELECT started_at,expires_at FROM hc_staging_owner_passkey_bootstrap WHERE id=1');
  assert.ok(started.rows[0].started_at);
  assert.ok(started.rows[0].expires_at);
  assert.ok(Math.abs(started.rows[0].expires_at.getTime()-started.rows[0].started_at.getTime()-14400000)<1000);
  assert.equal((await pool.query("SELECT 1 FROM hc_staging_owner_passkey_bootstrap_events WHERE kind='started'")).rowCount,1);
  await assert.rejects(fail.finishRegistration({
   context:login,challengeId:beginning.challengeId,response:{id:currentKey}
  }),e=>e.code==='HC_PASSKEY_DENIED');
  const rolledBack=await pool.query('SELECT 1 FROM hc_staff_passkeys WHERE credential_id=$1',[currentKey]);
  assert.equal(rolledBack.rowCount,0,'a rejected independent grant rolls back the verified credential');
  const rolledAudit=await pool.query('SELECT 1 FROM hc_staff_passkey_events WHERE credential_id=$1',[currentKey]);
  assert.equal(rolledAudit.rowCount,0,'a rejected grant rolls back the registration audit too');
  const state0=await pool.query('SELECT consumed_at FROM hc_staging_owner_passkey_bootstrap WHERE id=1');
  assert.equal(state0.rows[0].consumed_at,null);
  currentKey=randomBytes(24).toString('base64url');
  const accept=make(grant.commitRegistrationGrant);
  const next=await accept.beginRegistration({context:login,sourceIp:'127.0.0.1'});
  assert.equal((await accept.finishRegistration({
   context:login,challengeId:next.challengeId,response:{id:currentKey}
  })).registered,true);
  assert.equal((await pool.query('SELECT 1 FROM hc_staff_passkeys WHERE credential_id=$1',[currentKey])).rowCount,1);
  assert.equal((await pool.query("SELECT 1 FROM hc_staging_owner_passkey_bootstrap_events WHERE credential_id=$1 AND kind='completed'",[currentKey])).rowCount,1);
  assert.equal((await pool.query("SELECT 1 FROM hc_staging_owner_passkey_bootstrap_events WHERE kind='started'")).rowCount,1,'retry must not reactivate grant');
  const state1=await pool.query('SELECT consumed_at FROM hc_staging_owner_passkey_bootstrap WHERE id=1');
  assert.ok(state1.rows[0].consumed_at);
  await assert.rejects(accept.beginRegistration({context:login,sourceIp:'127.0.0.1'}),e=>e.code==='HC_PASSKEY_DENIED');
 }finally{await pool.end();}
});
