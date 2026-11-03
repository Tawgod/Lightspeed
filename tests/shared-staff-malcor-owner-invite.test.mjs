import test from 'node:test';
import assert from 'node:assert/strict';
import {createStaffEnrollmentInvitations} from '../services/security/staffEnrollmentInvitations.js';
const owner='115626919134887940',guild='1485804234753573066',channel='1566905099429744700';
const secret='test-only-malcor-hc-bot-key-0123456789abcdef';
function fake(){
 const statements=[];
 const pool={connect:async()=>({query:async(sql,args)=>{
  statements.push({sql,args});return {rows:[],rowCount:1};
 },release(){}})};
 return {statements,pool};
}
test('single owner test mode is impossible without exact isolated staging runtime',()=>{
 const original=process.env.HC_SECURITY_ENV;
 delete process.env.HC_SECURITY_ENV;
 try{
  const {pool}=fake();
  assert.throws(()=>createStaffEnrollmentInvitations({
   pool,botSecret:secret,tokenSecret:'test-only-enrollment-hmac-key-1234567890',
   guildId:guild,setupOrigin:'https://security.example.test',
   ownerOnlyTest:{environment:'isolated-staging',ownerDiscordId:owner,channelId:channel},
   verifyBoundEmployee:async()=>null,resolveDiscordEmployee:async()=>null,
   canInvite:async()=>true,requestEnrollment:async()=>null,
   throttle:{reserve:async()=>true}
  }),TypeError);
 }finally{if(original===undefined)delete process.env.HC_SECURITY_ENV;else process.env.HC_SECURITY_ENV=original;}
});
test('staging owner self-invite rejects other accounts, channel and guild; still needs active backend identity',async()=>{
 const before=process.env.HC_SECURITY_ENV;process.env.HC_SECURITY_ENV='isolated-staging';
 try{
  const {pool,statements}=fake();
  const cfg={
   pool,botSecret:secret,tokenSecret:'test-only-enrollment-hmac-key-1234567890',
   guildId:guild,setupOrigin:'https://security.example.test',
   ownerOnlyTest:{environment:'isolated-staging',ownerDiscordId:owner,channelId:channel},
   verifyBoundEmployee:async()=>null,
   resolveDiscordEmployee:async id=>id===owner?{id:77,discordUserId:owner,active:true}:null,
   canInvite:async x=>x.approverId==='77'&&x.employeeId==='77'&&x.operation==='staff.authenticator.invite',
   requestEnrollment:async()=>null,
   throttle:{reserve:async()=>true}
  };
  const service=createStaffEnrollmentInvitations(cfg);
  const good={botCredential:secret,guild,channelId:channel,
   actorDiscordId:owner,targetDiscordId:owner,roleIds:[]};
  for(const bad of [
   {...good,botCredential:'unknown'},
   {...good,guild:'2485804234753573066'},
   {...good,channelId:'2566905099429744700'},
   {...good,actorDiscordId:'215626919134887940'},
   {...good,targetDiscordId:'215626919134887940'},
   {...good,roleIds:['323456789012345678']},
   {...good,channelId:undefined}
  ])await assert.rejects(service.issue(bad),e=>e.code==='HC_INVITATION_DENIED');
  assert.equal(statements.length,0,'No database mutation for forbidden requests');
  const result=await service.issue(good);
  assert.match(result.link,/^https:\/\/security.example.test\/staff-security\/#invite=[A-Za-z0-9_-]{43}$/);
  assert.equal(result.employeeId,'77');
  assert.ok(statements.some(s=>String(s.sql).includes('hc_staff_security_invitations')));
  const noIdentity=createStaffEnrollmentInvitations({...cfg,resolveDiscordEmployee:async()=>null});
  await assert.rejects(noIdentity.issue(good),e=>e.code==='HC_INVITATION_DENIED');
  const noPermission=createStaffEnrollmentInvitations({...cfg,canInvite:async()=>false});
  await assert.rejects(noPermission.issue(good),e=>e.code==='HC_INVITATION_DENIED');
 }finally{if(before===undefined)delete process.env.HC_SECURITY_ENV;else process.env.HC_SECURITY_ENV=before;}
});
