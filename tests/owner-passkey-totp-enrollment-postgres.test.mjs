import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import {createOwnerPasskeyTotpEnrollmentCandidate}
 from '../services/security/ownerPasskeyTotpEnrollmentCandidate.js';

const uri=process.env.HC_TEST_DATABASE_URL;
const guarded={skip:!uri?'Disposable PostgreSQL required':false};
const abc='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(input){
 let bits=0,value=0,out=[];
 for(const char of input){
  value=(value<<5)|abc.indexOf(char);bits+=5;
  if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}
 }
 return Buffer.from(out);
}
function totp(secret,t){
 const counter=Buffer.alloc(8);
 counter.writeBigUInt64BE(BigInt(Math.floor(t/30000)));
 const mac=createHmac('sha1',base32(secret)).update(counter).digest();
 return String((mac.readUInt32BE(mac[19]&15)&0x7fffffff)%1000000).padStart(6,'0');
}

test('first commissioned Owner can approve same-account Google Authenticator only with fresh passkey',guarded,async()=>{
 if(!/hc_test/.test(uri))throw Error('Refusing non-disposable database');
 const adminPool=new pg.Pool({connectionString:uri,max:2});
 const schema='hc_owner_totp_'+process.pid;
 const now=Date.parse('2026-11-10T17:30:00Z');
 let db,server,ownerActive=true;
 try{
  await adminPool.query('CREATE SCHEMA '+schema);
  db=new pg.Pool({connectionString:uri,max:4,options:'-c search_path='+schema});
  for(const file of ['hc_admin_delegations.sql','hc_staff_auth_throttle.sql',
    'hc_staff_factor_approvals.sql','hc_staff_totp.sql']){
   await db.query(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  }
  await db.query("INSERT INTO hc_admin_principals(employee_id,role) VALUES(42,'owner')");
  const subsystem=createOwnerPasskeyTotpEnrollmentCandidate({
   environment:'test',enabled:true,expectedOwnerEmployeeId:'42',pool:db,
   now:()=>now,
   staffAuthGateway:{verifyBoundEmployee:async req=>{
    if(req.get('authorization')!=='Bearer signed')throw Error('bad session');
    return {id:'42',employeeId:'42',active:true,
      binding:'trusted-owner-timeclock-session-42',
      expiresAtMs:now+600000};
   }},
   timeclockIdentity:{authorize:async id=>({
    id,canLookup:true,permissionSource:'timeclock_employee'
   })},
   verifyOwnerPasskey:async req=>{
    if(req.get('x-hc-passkey-proof')!=='fresh-passkey')throw Error('missing strong proof');
    return {verified:true,employeeId:'42',method:'passkey',authenticatedAtMs:now-1000};
   },
   totpEncryptionKey:randomBytes(32),
   throttleHmacSecret:'isolated-test-only-throttle-secret-1234567890',
   approvalHmacSecret:'isolated-test-only-approval-secret-1234567890',
   mfaSessionSecret:'isolated-test-only-mfa-session-secret-1234567890'
  });
  const app=express();
  app.use('/security',subsystem.settingsRouter);
  server=await new Promise(resolve=>{
   const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  const origin='http://127.0.0.1:'+server.address().port+'/security/api';
  const auth={authorization:'Bearer signed'};
  const post=(path,body,headers={})=>fetch(origin+path,{
   method:'POST',headers:{'Content-Type':'application/json',...auth,...headers},
   body:JSON.stringify(body)
  });
  const request=await post('/enrollment-request',{});
  assert.equal(request.status,201);
  const {requestId}=await request.json();
  assert.equal(typeof requestId,'string');
  let res=await post('/enrollment-approve',{requestId});
  assert.equal(res.status,403,'PIN-derived session cannot approve own enrollment');
  res=await post('/enrollment-approve',{requestId},{'X-HC-Passkey-Proof':'fresh-passkey'});
  assert.equal(res.status,200,'fresh registered Owner passkey may approve same-account enrollment');
  assert.equal((await res.json()).approved,true);
  res=await post('/authenticator/enroll',{});
  assert.equal(res.status,200);
  const data=await res.json();
  assert.match(data.manualKey,/^[A-Z2-7]{32}$/);
  res=await post('/authenticator/confirm',{code:totp(data.manualKey,now)});
  assert.equal(res.status,200);
  assert.equal((await res.json()).confirmed,true);
  const factor=await db.query('SELECT status FROM hc_staff_totp WHERE employee_id=42');
  assert.equal(factor.rows[0].status,'active');
  assert.equal((await db.query(
   "SELECT state,approver_id,approver_method FROM hc_staff_factor_approvals WHERE request_id=$1",
   [requestId]
  )).rows[0].state,'finished');
  // Active Owner status is mandatory; a revoked Owner cannot approve another
  // request even with previously valid browser headers / fabricated proofs.
  await db.query("UPDATE hc_admin_principals SET active=false WHERE employee_id=42");
  ownerActive=false;
  const next=await post('/enrollment-request',{});
  assert.equal(next.status,201);
  const nextId=(await next.json()).requestId;
  const rejected=await post('/enrollment-approve',{requestId:nextId},
   {'X-HC-Passkey-Proof':'fresh-passkey'});
  assert.equal(rejected.status,403);
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(db)await db.end();
  await adminPool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
  await adminPool.end();
 }
});

test('Owner self-enrollment refuses production mode and missing verifier',()=>{
 assert.throws(()=>createOwnerPasskeyTotpEnrollmentCandidate(),TypeError);
 assert.throws(()=>createOwnerPasskeyTotpEnrollmentCandidate({
  environment:'production',enabled:true,expectedOwnerEmployeeId:'42'
 }),TypeError);
});
