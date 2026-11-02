import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createSign,generateKeyPairSync,randomBytes} from 'node:crypto';
import pg from 'pg';
import express from 'express';
import * as verifier from '@simplewebauthn/server';
import {createStaffAuthGateway} from '../services/staffAuthGateway.js';
import {createPostgresStaffPasskeys} from '../services/security/staffPasskeysPostgres.js';
import {createPostgresStaffLoginThrottle} from '../services/security/staffLoginThrottle.js';
import {createStaffPasskeyRouter} from '../routes/staffPasskey.js';
import {createStaffSecuritySubsystem} from '../services/security/staffSecuritySubsystem.js';
import {createStaffSecurityAccessGate,createStaffBoundSessionAdapter}
  from '../services/security/staffSecurityBridge.js';

const db=process.env.HC_TEST_DATABASE_URL;
const gated={skip:!db?'Requires disposable hc_test Postgres':false};
const DENY=e=>e?.code==='HC_PASSKEY_DENIED';
const id=()=>randomBytes(32).toString('base64url');
const signedData=(challenge,origin,privateKey,counter=1)=>{
 const auth=Buffer.concat([
   createHash('sha256').update('localhost').digest(),Buffer.from([0x05]),
   Buffer.from([0,0,0,counter])
 ]);
 const client=Buffer.from(JSON.stringify({
   type:'webauthn.get',challenge,origin,crossOrigin:false
 }));
 const signature=createSign('SHA256')
   .update(Buffer.concat([auth,createHash('sha256').update(client).digest()]))
   .end().sign(privateKey);
 return {
   id:'',rawId:'',type:'public-key',
   response:{
     authenticatorData:auth.toString('base64url'),
     clientDataJSON:client.toString('base64url'),
     signature:signature.toString('base64url'),
     userHandle:null
   },
   clientExtensionResults:{}
 };
};
function ec2Cose(publicKey){
 const jwk=publicKey.export({format:'jwk'});
 return Buffer.concat([
   Buffer.from([0xa5,0x01,0x02,0x03,0x26,0x20,0x01,0x21,0x58,0x20]),
   Buffer.from(jwk.x,'base64url'),
   Buffer.from([0x22,0x58,0x20]),
   Buffer.from(jwk.y,'base64url')
 ]);
}

test('real ES256 passkey assertion, session binding, manager proof, counter and revocation',gated,async()=>{
 if(!/hc_test/.test(db))throw Error('Refusing database other than disposable hc_test.');
 const pool=new pg.Pool({connectionString:db,max:10});
 let clock=Date.parse('2026-11-02T16:00:00Z');
 let active=true,grant=false;
 const credentialId=id();
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const cose=ec2Cose(publicKey);
 const account={
   verifyPin:async pin=>pin==='9182'?{id:57,name:'Test Manager'}:
     pin==='9183'?{id:58,name:'Test Staff'}:
     Promise.reject(Object.assign(new Error('Invalid PIN'),{status:401})),
   authorize:async value=>active&&['57','58'].includes(String(value))?
     {id:Number(value),name:String(value)==='57'?'Test Manager':'Test Staff'}:null
 };
 const auth=createStaffAuthGateway({
   identity:account,loginLimiter:async()=>true,
   sessionSecret:'test-only-hc-passkey-base-signed-session-secret-123',
   clock:()=>clock
 });
 const provider={
   ...verifier,
   verifyRegistrationResponse:async args=>{
     assert.equal(args.expectedOrigin,'http://localhost');
     assert.equal(args.expectedRPID,'localhost');
     assert.equal(args.requireUserVerification,true);
     assert.ok(args.expectedChallenge);
     return {verified:true,registrationInfo:{
       credential:{id:credentialId,publicKey:new Uint8Array(cose),counter:0,transports:['internal']},
       credentialDeviceType:'multiDevice',credentialBackedUp:true
     }};
   }
 };
 try{
   for(const name of ['hc_staff_auth_throttle.sql','hc_staff_passkeys.sql',
     'hc_staff_factor_approvals.sql','hc_staff_totp.sql'])
     await pool.query(await readFile(new URL('../db/'+name,import.meta.url),'utf8'));
   const passkeys=createPostgresStaffPasskeys({
     pool,origin:'http://localhost',rpID:'localhost',
     signingSecret:'test-only-hc-passkey-proofs-secret-1234567890',
     now:()=>clock,verifyBoundEmployee:auth.verifyBoundEmployee,
     authorizeRegistration:async({employeeId})=>grant&&employeeId==='57',
     verifyStrongManager:async()=>{throw Error('No independent manager claim yet');},
     canManage:async({approverId})=>approverId==='57',
     loginThrottle:createPostgresStaffLoginThrottle({
       pool,secret:'test-only-hc-passkey-rate-limiter-secret-12345',
       scope:'hc:staff:passkey-test'
     }),webauthn:provider
   });
   const security=createStaffSecuritySubsystem({
     staffAuthGateway:auth,pool,now:()=>clock,
     totpEncryptionKey:randomBytes(32),
     throttleHmacSecret:'test-only-passkey-integrated-throttle-hmac-secret-12345',
     approvalHmacSecret:'test-only-passkey-integrated-approval-hmac-secret-12345',
     mfaSessionSecret:'test-only-passkey-integrated-mfa-hmac-secret-123456',
     verifyStrongManager:ctx=>passkeys.verifyStrongManager(ctx),
     canApproveEnrollment:async p=>p.approverId==='57'&&p.employeeId==='58'&&
       p.operation==='staff.authenticator.enroll',
     canRecoverFactor:async()=>false
   });
   const app=express();
   app.use('/api/staff-auth',auth.router);
   app.use('/passkey',createStaffPasskeyRouter({passkeys}));
   app.use('/staff-security',security.settingsRouter);
   const server=await new Promise(ok=>{
     const s=app.listen(0,'127.0.0.1',()=>ok(s));
   });
   const origin='http://127.0.0.1:'+server.address().port;
   const post=(path,body,headers={})=>fetch(origin+path,{
     method:'POST',headers:{'Content-Type':'application/json',...headers},
     body:JSON.stringify(body)
   });
   try{
     const login=await post('/api/staff-auth/session',{pin:'9182'});
     assert.equal(login.status,200);
     const token=(await login.json()).token;
     const h={Authorization:'Bearer '+token};
     const forged=await post('/passkey/registration/options',{},
       {'X-Employee-Role':'admin','X-Strong-MFA':'yes'});
     assert.equal(forged.status,403);
     const noGrant=await post('/passkey/registration/options',{},h);
     assert.equal(noGrant.status,403,'PIN alone never grants registration');
     grant=true;
     const registration=await post('/passkey/registration/options',{},h);
     assert.equal(registration.status,200);
     const options=await registration.json();
     assert.equal(options.options.authenticatorSelection.userVerification,'required');
     assert.match(options.challengeId,/^[a-f0-9-]{36}$/);
     const enrolled=await post('/passkey/registration/verify',{
       challengeId:options.challengeId,response:{id:credentialId}
     },h);
     assert.equal(enrolled.status,200);
     assert.deepEqual(await enrolled.json(),{registered:true});
     const replay=await post('/passkey/registration/verify',{
       challengeId:options.challengeId,response:{id:credentialId}
     },h);
     assert.equal(replay.status,403);
     const rows=await pool.query(
       'SELECT public_key,counter FROM hc_staff_passkeys WHERE credential_id=$1',[credentialId]);
     assert.equal(rows.rowCount,1);
     assert.equal(rows.rows[0].public_key.toString('base64url'),cose.toString('base64url'));

     const start=await post('/passkey/authentication/options',{},h);
     assert.equal(start.status,200);
     const ceremony=await start.json();
     assert.equal(ceremony.options.userVerification,'required');
     const fake=signedData(ceremony.options.challenge,'http://evil.example',privateKey);
     fake.id=fake.rawId=credentialId;
     const wrongOrigin=await post('/passkey/authentication/verify',{
       challengeId:ceremony.challengeId,response:fake
     },h);
     assert.equal(wrongOrigin.status,403,'WebAuthn rejects a mismatched origin');
     const replayWrong=await post('/passkey/authentication/verify',{
       challengeId:ceremony.challengeId,response:fake
     },h);
     assert.equal(replayWrong.status,403,'failed assertion consumes challenge');

     const again=await post('/passkey/authentication/options',{},h);
     const ceremony2=await again.json();
     const assertion=signedData(ceremony2.options.challenge,'http://localhost',privateKey);
     assertion.id=assertion.rawId=credentialId;
     const authenticated=await post('/passkey/authentication/verify',{
       challengeId:ceremony2.challengeId,response:assertion
     },h);
     assert.equal(authenticated.status,200,'real ES256 assertion must verify');
     const {token:proof,expiresIn}=await authenticated.json();
     assert.equal(expiresIn,300);
     assert.ok(proof);
     const verified=await fetch(origin+'/passkey/session',{headers:{
       ...h,'X-HC-Passkey-Proof':proof
     }});
     assert.equal(verified.status,200);
     assert.equal((await verified.json()).method,'passkey');
     const bare=await fetch(origin+'/passkey/session',{headers:{
       'X-HC-Passkey-Proof':proof,'X-Employee-Role':'admin'
     }});
     assert.equal(bare.status,403);
     const second=await post('/api/staff-auth/session',{pin:'9182'});
     const newSession=(await second.json()).token;
     const crossSession=await fetch(origin+'/passkey/session',{headers:{
       Authorization:'Bearer '+newSession,'X-HC-Passkey-Proof':proof
     }});
     assert.equal(crossSession.status,403);
     // Full manager approval integration: PIN-only and forged role both fail.
     const staffLogin=await post('/api/staff-auth/session',{pin:'9183'});
     assert.equal(staffLogin.status,200);
     const staffToken=(await staffLogin.json()).token;
     const staffHeaders={Authorization:'Bearer '+staffToken};
     const employeeRequest=await post('/staff-security/api/enrollment-request',{},staffHeaders);
     assert.equal(employeeRequest.status,201);
     const managerRequest=(await employeeRequest.json()).requestId;
     const forgedApproval=await post('/staff-security/api/enrollment-approve',{
       requestId:managerRequest
     },{...h,'X-Employee-Role':'admin'});
     assert.equal(forgedApproval.status,403,'manager PIN and role header are not enough');
     const authorizedApproval=await post('/staff-security/api/enrollment-approve',{
       requestId:managerRequest
     },{...h,'X-HC-Passkey-Proof':proof});
     assert.equal(authorizedApproval.status,200,
       'real signed manager passkey proof authorizes exact employee enrollment grant');
     assert.equal((await authorizedApproval.json()).approved,true);
     const employeeEnrollment=await post('/staff-security/api/authenticator/enroll',{},staffHeaders);
     assert.equal(employeeEnrollment.status,200);
     assert.match((await employeeEnrollment.json()).manualKey,/^[A-Z2-7]{32}$/);
     const count=await pool.query('SELECT counter FROM hc_staff_passkeys WHERE credential_id=$1',[credentialId]);
     assert.equal(Number(count.rows[0].counter),1);
     const tampered=await fetch(origin+'/passkey/session',{headers:{
       ...h,'X-HC-Passkey-Proof':proof.slice(0,-1)+'x'
     }});
     assert.equal(tampered.status,403);

     const staffSession=createStaffBoundSessionAdapter({staffAuth:auth,now:()=>clock});
     const policy=createStaffSecurityAccessGate({
       staffSession,mfa:{verify:async()=>{throw Error('No TOTP');}},
       verifyStrongStepUp:async(req,identity)=>passkeys.verifyStepUp(req,identity),
       checkPermission:async({operation})=>operation==='products.write',
       now:()=>clock
     });
     const request={get:name=>name.toLowerCase()==='authorization'?h.Authorization:
       name.toLowerCase()==='x-hc-passkey-proof'?proof:null};
     const accepted=await policy.authorize({request,action:'products.write'});
     assert.equal(accepted.factorMethod,'passkey');
     await assert.rejects(policy.authorize({request,action:'inventory.adjust'}),
       e=>e.code==='HC_STAFF_ACCESS_DENIED','exact permission still required');

     // Revoke after a separately authenticated manager proof and exact grant.
     // Here the same signed passkey satisfies the test-only manager grant.
     const manage=createPostgresStaffPasskeys({
       pool,origin:'http://localhost',rpID:'localhost',
       signingSecret:'test-only-hc-passkey-proofs-secret-1234567890',
       now:()=>clock,verifyBoundEmployee:auth.verifyBoundEmployee,
       authorizeRegistration:async()=>false,
       verifyStrongManager:async context=>passkeys.verifyStrongManager(context),
       canManage:async({operation,approverId})=>
         operation==='staff.passkey.revoke'&&approverId==='57',
       loginThrottle:{reserve:async()=>true},webauthn:provider
     });
     const ctx={get:name=>request.get(name)};
     assert.equal((await manage.revoke({context:ctx,credentialId})).revoked,true);
     const after=await fetch(origin+'/passkey/session',{headers:{
       ...h,'X-HC-Passkey-Proof':proof
     }});
     assert.equal(after.status,403,'revocation invalidates old proofs');
     const audit=await pool.query(
       'SELECT kind FROM hc_staff_passkey_events WHERE credential_id=$1',[credentialId]);
     assert.deepEqual(audit.rows.map(x=>x.kind).sort(),['registered','revoked']);
     await assert.rejects(pool.query(
       'DELETE FROM hc_staff_passkey_events WHERE credential_id=$1',[credentialId]),
       /append-only/);
     active=false;
     await assert.rejects(passkeys.verify({context:request,token:proof}),DENY);
   }finally{await new Promise(resolve=>server.close(resolve));}
 }finally{await pool.end();}
});
test('passkey service refuses absent trusted verifiers and arbitrary RPs',()=>{
 assert.throws(()=>createPostgresStaffPasskeys(),TypeError);
 assert.throws(()=>createStaffPasskeyRouter(),TypeError);
 assert.throws(()=>createPostgresStaffPasskeys({
   pool:{connect(){}},origin:'https://attacker.example',rpID:'hobbycorner.example',
   signingSecret:'trusted-test-only-passkey-signing-key-123456',
   verifyBoundEmployee:async()=>{},authorizeRegistration:async()=>true,
   verifyStrongManager:async()=>{},canManage:async()=>true,
   loginThrottle:{reserve:async()=>true}
 }),TypeError);
});
