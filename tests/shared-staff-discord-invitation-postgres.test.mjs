import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac,randomBytes} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import {createStaffAuthGateway} from '../services/staffAuthGateway.js';
import {createStaffSecuritySubsystem} from '../services/security/staffSecuritySubsystem.js';

const url=process.env.HC_TEST_DATABASE_URL;
const testOpts={skip:!url?'Disposable hc_test PostgreSQL required':false};
const guild='123456789012345678',staffRole='223456789012345678',
  adminRole='323456789012345678',ownerRole='423456789012345678';
const managerDiscord='523456789012345678',staffDiscord='623456789012345678',
  otherDiscord='723456789012345678';
function totpCode(secret,ms){
 const alpha='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
 let bits=0,value=0,bytes=[];
 for(const c of secret){
   value=(value<<5)|alpha.indexOf(c);bits+=5;
   if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);value&=(1<<bits)-1;}
 }
 const buf=Buffer.alloc(8);buf.writeBigUInt64BE(BigInt(Math.floor(ms/30000)));
 const hash=createHmac('sha1',Buffer.from(bytes)).update(buf).digest();
 return String((hash.readUInt32BE(hash.at(-1)&15)&0x7fffffff)%1000000).padStart(6,'0');
}
test('Hobby Bot Admin invitation -> staff PIN sign-in -> independent manager approval -> QR + 6-digit signup',testOpts,async()=>{
 if(!/hc_test/.test(url))throw Error('Never run against a non-test database.');
 const pool=new pg.Pool({connectionString:url,max:16});
 let now=Date.parse('2026-11-02T18:00:00Z');
 const employees={
  '57':{id:57,name:'Synthetic Manager',discordUserId:managerDiscord,active:true},
  '58':{id:58,name:'Synthetic Employee',discordUserId:staffDiscord,active:true},
  '59':{id:59,name:'Unrelated Employee',discordUserId:otherDiscord,active:true}
 };
 const key='test-only-hc-enrollment-bot-private-key-1234567890';
 try{
  for(const file of [
    'hc_staff_auth_throttle.sql','hc_staff_factor_approvals.sql',
    'hc_staff_totp.sql','hc_staff_security_invitations.sql'
  ])await pool.query(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  const auth=createStaffAuthGateway({
   sessionSecret:'test-only-bot-invite-signed-timeclock-key-1234567890',
   clock:()=>now,loginLimiter:async()=>true,
   identity:{
    verifyPin:async p=>{
     const id=({'9182':'57','9183':'58','9184':'59'})[p];
     if(!id)throw Object.assign(new Error('No PIN'),{status:401});
     return employees[id];
    },
    authorize:async id=>employees[String(id)]||null
   }
  });
  const security=createStaffSecuritySubsystem({
   staffAuthGateway:auth,pool,now:()=>now,
   totpEncryptionKey:randomBytes(32),
   throttleHmacSecret:'test-only-bot-invite-persistent-rate-hmac-1234567',
   approvalHmacSecret:'test-only-bot-invite-approval-session-hmac-12345',
   mfaSessionSecret:'test-only-bot-invite-mfa-signing-hmac-1234567890',
   verifyStrongManager:async req=>{
    const identity=await auth.verifyBoundEmployee(req);
    return identity.id==='57'&&req.get('x-test-independent-factor')==='test-verified'
      ?{id:57,active:true,method:'passkey',authenticatedAtMs:now-1000}:null;
   },
   canApproveEnrollment:async x=>x.approverId==='57'&&x.employeeId==='58'&&
     x.operation==='staff.authenticator.enroll',
   canRecoverFactor:async()=>false,
   enrollmentInvitations:{
     botSecret:key,tokenSecret:'test-only-bot-invite-dedicated-hmac-key-12345678',
     guildId:guild,staffRoleId:staffRole,adminRoleId:adminRole,ownerRoleId:ownerRole,
     setupOrigin:'http://localhost',
     resolveDiscordEmployee:async did=>Object.values(employees).find(e=>e.discordUserId===did)||null,
     canInvite:async x=>x.approverId==='57'&&x.employeeId==='58'&&
       x.operation==='staff.authenticator.invite'
   }
  });
  assert.equal(typeof security.invitationRouter,'function');
  const app=express();
  app.use('/api/staff-auth',auth.router);
  app.use('/staff-enrollment-invites',security.invitationRouter);
  app.use('/staff-security',security.settingsRouter);
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  const origin='http://127.0.0.1:'+server.address().port;
  const post=(endpoint,body,headers={})=>fetch(origin+endpoint,{
    method:'POST',headers:{'Content-Type':'application/json',...headers},
    body:JSON.stringify(body)
  });
  try{
   const login=async pin=>{
    const resp=await post('/api/staff-auth/session',{pin});
    assert.equal(resp.status,200);
    return {Authorization:'Bearer '+(await resp.json()).token};
   };
   const admin=await login('9182'),staff=await login('9183'),unrelated=await login('9184');
   const request={
    guildId:guild,actorDiscordId:managerDiscord,targetDiscordId:staffDiscord,
    roleIds:[adminRole]
   };
   const botHeader={'x-hc-invitation-bot-key':key};
   const badKey=await post('/staff-enrollment-invites/bot/issue',request);
   assert.equal(badKey.status,403,'No private bot credential means no invite');
   const forgedStaff=await post('/staff-enrollment-invites/bot/issue',{
     ...request,roleIds:[staffRole]
   },botHeader);
   assert.equal(forgedStaff.status,403,'Staff may not invite others');
   const wrongGuild=await post('/staff-enrollment-invites/bot/issue',{
     ...request,guildId:'823456789012345678'
   },botHeader);
   assert.equal(wrongGuild.status,403,'Untrusted guild rejected');
   const wrongTarget=await post('/staff-enrollment-invites/bot/issue',{
     ...request,targetDiscordId:otherDiscord
   },botHeader);
   assert.equal(wrongTarget.status,403,'Exact target permission is required');
   const invited=await post('/staff-enrollment-invites/bot/issue',request,botHeader);
   assert.equal(invited.status,201);
   const invitation=await invited.json();
   assert.match(invitation.link,/^http:\/\/localhost\/staff-security\/#invite=[A-Za-z0-9_-]{43}$/);
   const token=invitation.link.split('=')[1];
   const requestDirectly=await post('/staff-security/api/enrollment-request',{},staff);
   assert.equal(requestDirectly.status,403,'Employee cannot self-initiate enrollment');
   const wrongEmployee=await post('/staff-enrollment-invites/redeem',{token},unrelated);
   assert.equal(wrongEmployee.status,403,'Invitation is bound to intended employee');
   const unsigned=await post('/staff-enrollment-invites/redeem',{token});
   assert.equal(unsigned.status,403,'Invitation link is not an authentication credential');
   const redeem=await post('/staff-enrollment-invites/redeem',{token},staff);
   assert.equal(redeem.status,201);
   const approval=await redeem.json();
   assert.match(approval.requestId,/^[a-f0-9-]{36}$/);
   const reuse=await post('/staff-enrollment-invites/redeem',{token},staff);
   assert.equal(reuse.status,409,'One-time invite cannot be redeemed again');
   const enrollBefore=await post('/staff-security/api/authenticator/enroll',{},staff);
   assert.equal(enrollBefore.status,403,'Invite alone never reveals seed or QR');
   const roleForged=await post('/staff-security/api/enrollment-approve',
     {requestId:approval.requestId},{...admin,'X-Employee-Role':'owner'});
   assert.equal(roleForged.status,403,'Manager PIN + header cannot approve');
   const managerApproved=await post('/staff-security/api/enrollment-approve',
     {requestId:approval.requestId},{...admin,'x-test-independent-factor':'test-verified'});
   assert.equal(managerApproved.status,200);
   assert.equal((await managerApproved.json()).approved,true);
   const begin=await post('/staff-security/api/authenticator/enroll',{},staff);
   assert.equal(begin.status,200);
   const qr=await begin.json();
   assert.match(qr.manualKey,/^[A-Z2-7]{32}$/);
   assert.match(qr.qrDataUrl,/^data:image\/png;base64,/);
   const confirm=await post('/staff-security/api/authenticator/confirm',{
     code:totpCode(qr.manualKey,now)
   },staff);
   assert.equal(confirm.status,200);
   assert.equal((await confirm.json()).confirmed,true);
   const status=await fetch(origin+'/staff-security/api/authenticator',{headers:staff});
   assert.deepEqual(await status.json(),{state:'active'});
   const secondEnroll=await post('/staff-security/api/authenticator/enroll',{},staff);
   assert.equal(secondEnroll.status,403);
   const audited=await pool.query(
     'SELECT kind FROM hc_staff_security_invitation_events WHERE invitation_id=$1',[invitation.invitationId]);
   assert.deepEqual(audited.rows.map(r=>r.kind).sort(),['issued','redeemed']);
   await assert.rejects(
     pool.query('DELETE FROM hc_staff_security_invitation_events WHERE invitation_id=$1',[invitation.invitationId]),
     /append-only/
   );
  }finally{await new Promise(ok=>server.close(ok));}
 }finally{await pool.end();}
});
test('Bot invitation composition fails closed without required credentials',()=>{
 assert.throws(()=>createStaffSecuritySubsystem(),TypeError);
});
