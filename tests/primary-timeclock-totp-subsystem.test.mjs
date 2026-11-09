import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrimaryTimeclockTotpSubsystem}
  from '../services/security/primaryTimeclockTotpSubsystem.js';

const NOW=Date.parse('2026-11-09T22:30:00Z');
const context={token:'valid'};
const session=()=>({id:'42',employeeId:'42',active:true,
 binding:'signed-real-employee-session-01',expiresAtMs:NOW+60000});
const canonical={id:'42',canLookup:true,permissionSource:'timeclock_employee'};
const manager={id:'7',active:true,method:'passkey',authenticatedAtMs:NOW-1000};
const opts=(overrides={})=>({
  environment:'test',enabled:true,now:()=>NOW,
  staffAuthGateway:{verifyBoundEmployee:async req=>{
    if(req!==context)throw Error('unsigned');return session();
  }},
  timeclockIdentity:{authorize:async id=>({...canonical,id})},
  pool:{connect:async()=>({})},
  totpEncryptionKey:'not-read-by-injected-subsystem',
  throttleHmacSecret:'unused-in-test',
  approvalHmacSecret:'unused-in-test',
  mfaSessionSecret:'unused-in-test',
  verifyStrongApprover:async()=>manager,
  canApproveEnrollment:async()=>true,
  canRecoverFactor:async()=>false,
  ...overrides
});
test('composes existing security subsystem with exact canonical Timeclock bound identity and strong manager',async()=>{
 let verified=null;
 const mounted={settingsRouter:()=>{},verifyTotpStepUp:async()=>({verified:true})};
 const subsystem=createPrimaryTimeclockTotpSubsystem(opts({
  createSubsystem:settings=>{
   verified=settings;
   return mounted;
  }
 }));
 assert.equal(subsystem.settingsRouter,mounted.settingsRouter);
 assert.deepEqual(await verified.staffAuthGateway.verifyBoundEmployee(context),{
  id:'42',employeeId:'42',active:true,
  binding:'signed-real-employee-session-01',expiresAtMs:NOW+60000
 });
 assert.deepEqual(await verified.verifyStrongManager(context),manager);
 assert.equal(await verified.canApproveEnrollment({context,approverId:'7',employeeId:'42',operation:'staff.authenticator.enroll'}),true);
 assert.equal(await verified.canApproveEnrollment({context,approverId:'7',employeeId:'7',operation:'staff.authenticator.enroll'}),false);
 assert.equal(await verified.canRecoverFactor({employeeId:'42'}),false);
 assert.equal(verified.enrollmentInvitations,undefined);
 assert.deepEqual(Object.keys(subsystem),['settingsRouter','verifyTotpStepUp']);
});
test('denies production activation, default-off enrollment and missing core adapters',()=>{
 for(const changes of [{environment:'production'},{enabled:false},
  {staffAuthGateway:null},{timeclockIdentity:null},
  {verifyStrongApprover:null},{pool:null}]){
  assert.throws(()=>createPrimaryTimeclockTotpSubsystem(opts(changes)),TypeError);
 }
});
test('rejects synthetic staging primary account at each downstream factor check',async()=>{
 let capture;
 createPrimaryTimeclockTotpSubsystem(opts({
  staffAuthGateway:{verifyBoundEmployee:async()=>({
   ...session(),id:'901',employeeId:'901'
  })},
  timeclockIdentity:{authorize:async()=>({
   id:'901',canLookup:true,permissionSource:'synthetic_staging_only'
  })},
  createSubsystem:p=>{capture=p;return {
   settingsRouter:()=>{},verifyTotpStepUp:async()=>null
  };}
 }));
 await assert.rejects(
  capture.staffAuthGateway.verifyBoundEmployee(context),
  e=>e?.status===403
 );
});
test('PIN-only manager factor is not accepted for Authenticator setup',async()=>{
 let capture;
 createPrimaryTimeclockTotpSubsystem(opts({
  verifyStrongApprover:async()=>({...manager,method:'totp'}),
  createSubsystem:p=>{capture=p;return {
    settingsRouter:()=>{},verifyTotpStepUp:async()=>null
  };}
 }));
 await assert.rejects(capture.verifyStrongManager(context),e=>e?.status===403);
});
test('an incomplete or injected broken security subsystem is refused',()=>{
 assert.throws(()=>createPrimaryTimeclockTotpSubsystem(opts({
  createSubsystem:()=>({settingsRouter:()=>{}})
 })),TypeError);
});
