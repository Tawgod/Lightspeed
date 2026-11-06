import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { createStaffAuthGateway } from '../services/staffAuthGateway.js';
import { createStaffSecuritySubsystem } from '../services/security/staffSecuritySubsystem.js';

const url=process.env.HC_TEST_DATABASE_URL;
const gated={skip:!url?'Disposable hc_test PostgreSQL required':false};
function totpCode(secret,ms){
  const alpha='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits=0,value=0;const raw=[];
  for(const char of secret){
    value=(value<<5)|alpha.indexOf(char);bits+=5;
    if(bits>=8){bits-=8;raw.push((value>>>bits)&255);value&=(1<<bits)-1;}
  }
  const buf=Buffer.alloc(8);buf.writeBigUInt64BE(BigInt(Math.floor(ms/30000)));
  const hash=createHmac('sha1',Buffer.from(raw)).update(buf).digest();
  return String((hash.readUInt32BE(hash.at(-1)&15)&0x7fffffff)%1_000_000).padStart(6,'0');
}
test('full safe employee PIN -> independent manager approval -> QR -> MFA -> revoked session',gated,async()=>{
  if(!/hc_test/.test(url)) throw Error('Refusing non-test database.');
  const pool=new pg.Pool({connectionString:url,max:12});
  let now=Date.parse('2026-10-30T21:40:00Z');
  try{
    for(const file of ['hc_staff_auth_throttle.sql','hc_staff_factor_approvals.sql','hc_staff_totp.sql']){
      await pool.query(await fs.readFile(new URL('../db/'+file,import.meta.url),'utf8'));
    }
    const staffAuth=createStaffAuthGateway({
      sessionSecret:'test-only-timeclock-session-jti-hmac-key-123456789',
      clock:()=>now,
      identity:{
        verifyPin:async pin=>pin==='9182'?{id:57,name:'Test employee'}:
          Promise.reject(Object.assign(new Error('invalid'),{status:401})),
        authorize:async id=>String(id)==='57'?{id:57,name:'Test employee'}:null
      },
      loginLimiter:async()=>true
    });
    const security=createStaffSecuritySubsystem({
      staffAuthGateway:staffAuth,pool,now:()=>now,
      totpEncryptionKey:randomBytes(32),
      throttleHmacSecret:'test-only-enrollment-and-TOTP-bucket-hmac-key-123456789',
      approvalHmacSecret:'test-only-factor-enrollment-session-hmac-key-123456789',
      mfaSessionSecret:'test-only-mobile-stepup-mfa-session-hmac-key-123456789',
      verifyStrongManager:async ctx=>
        (ctx?.strong===true || ctx?.get?.('authorization')==='Bearer independent-manager-passkey')
        ?{id:8,active:true,method:'passkey',authenticatedAtMs:now-1000}
        :null,
      canApproveEnrollment:async p=>p.approverId==='8' && p.employeeId==='57' &&
        p.operation==='staff.authenticator.enroll',
      canRecoverFactor:async p=>p.approverId==='8' && p.employeeId==='57' &&
        p.operation==='staff.authenticator.recover'
    });
    const app=express();
    app.use('/api/staff-auth',staffAuth.router);
    app.use('/staff-security',security.settingsRouter);
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
    const base='http://127.0.0.1:'+server.address().port;
    try{
      const pinLogin=await fetch(base+'/api/staff-auth/session',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'9182'})
      });
      assert.equal(pinLogin.status,200);
      const sessionToken=(await pinLogin.json()).token;
      const headers={Authorization:'Bearer '+sessionToken,'Content-Type':'application/json'};
      const before=await fetch(base+'/staff-security/api/authenticator/enroll',{
        method:'POST',headers,body:'{}'
      });
      assert.equal(before.status,403,'PIN-only session cannot enroll factor');
      const requested=await fetch(base+'/staff-security/api/enrollment-request',{
        method:'POST',headers,body:'{}'
      });
      assert.equal(requested.status,201);
      const approval=await requested.json();
      assert.match(approval.requestId,/^[0-9a-f-]{36}$/);
      const forged=await fetch(base+'/staff-security/api/enrollment-approve',{
        method:'POST',headers:{...headers,'X-Employee-Role':'admin'},
        body:JSON.stringify({requestId:approval.requestId})
      });
      assert.equal(forged.status,403);
      const manager=await fetch(base+'/staff-security/api/enrollment-approve',{
        method:'POST',headers:{Authorization:'Bearer independent-manager-passkey',
          'Content-Type':'application/json'},body:JSON.stringify({requestId:approval.requestId})
      });
      assert.equal(manager.status,200);
      assert.equal((await manager.json()).approved,true);
      const enroll=await fetch(base+'/staff-security/api/authenticator/enroll',{
        method:'POST',headers,body:'{}'
      });
      assert.equal(enroll.status,200);
      const data=await enroll.json();
      assert.match(data.manualKey,/^[A-Z2-7]{32}$/);
      assert.match(data.qrDataUrl,/^data:image\/png;base64,/);
      const again=await fetch(base+'/staff-security/api/authenticator/enroll',{
        method:'POST',headers,body:'{}'
      });
      assert.equal(again.status,403,'approval cannot begin another setup');
      const confirmed=await fetch(base+'/staff-security/api/authenticator/confirm',{
        method:'POST',headers,body:JSON.stringify({code:totpCode(data.manualKey,now)})
      });
      assert.equal(confirmed.status,200);
      assert.equal((await confirmed.json()).confirmed,true);
      const state=await fetch(base+'/staff-security/api/authenticator',{headers});
      assert.deepEqual(await state.json(),{state:'active'});
      now+=30000;
      const mobile=await fetch(base+'/staff-security/api/mfa/session',{
        method:'POST',headers,body:JSON.stringify({code:totpCode(data.manualKey,now)})
      });
      assert.equal(mobile.status,200);
      const mfa=await mobile.json();
      assert.equal(mfa.expiresIn,300);
      const proof=await fetch(base+'/staff-security/api/mfa/session',{
        headers:{Authorization:headers.Authorization,'X-HC-MFA-Session':mfa.token}
      });
      assert.equal(proof.status,200);
      const unrelated=await fetch(base+'/staff-security/api/mfa/session',{
        headers:{'X-HC-MFA-Session':mfa.token}
      });
      assert.equal(unrelated.status,401);
      await assert.rejects(security.recovery.revoke({
        context:{},employeeId:'57',reason:'lost_device'
      }),e=>e.code==='HC_FACTOR_RECOVERY_DENIED');
      const removed=await security.recovery.revoke({
        context:{strong:true},employeeId:'57',reason:'lost_device'
      });
      assert.equal(removed.revoked,true);
      const stale=await fetch(base+'/staff-security/api/mfa/session',{
        headers:{Authorization:headers.Authorization,'X-HC-MFA-Session':mfa.token}
      });
      assert.equal(stale.status,401,'recovery immediately invalidates earlier MFA proof');
    }finally{await new Promise(resolve=>server.close(resolve))}
  }finally{await pool.end()}
});
