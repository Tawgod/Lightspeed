import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCanonicalStaffFactorSession,
  createCanonicalStaffFactorApprovalPolicy
} from '../services/security/primaryLiveTotpEnrollmentGate.js';
import {createStaffApprovedEnrollmentAdapters} from '../services/security/staffEnrollmentSettings.js';

const NOW=Date.parse('2026-11-09T22:00:00Z');
const req=Object.freeze({signed:true});
const session=()=>({id:'42',employeeId:'42',active:true,
  binding:'signed-primary-session-1234567890',expiresAtMs:NOW+60_000,
  role:'owner',pin:'0000'});
const canonical=()=>({id:'42',canLookup:true,canApprove:true,
  permissionSource:'timeclock_employee'});
const denied=e=>e?.code==='HC_PRIMARY_TOTP_SESSION_DENIED'&&e.status===403;
const unavailable=e=>e?.code==='HC_PRIMARY_TOTP_SESSION_UNAVAILABLE'&&e.status===503;
function make({staff=session(),resolved=canonical()}={}){
 const calls=[];
 const access=createCanonicalStaffFactorSession({
  now:()=>NOW,
  staffAuthGateway:{verifyBoundEmployee:async context=>{
    calls.push('signed');if(context!==req)throw Error('bad session');return staff;
  }},
  timeclockIdentity:{authorize:async id=>{
    calls.push('timeclock:'+id);
    if(resolved instanceof Error)throw resolved;
    return resolved;
  }}
 });
 return {access,calls};
}
test('real primary Timeclock identity preserves only safe signed session fields',async()=>{
 const {access,calls}=make();
 assert.deepEqual(await access.verifyBoundEmployee(req),{
  id:'42',employeeId:'42',active:true,binding:'signed-primary-session-1234567890',
  expiresAtMs:NOW+60_000
 });
 assert.deepEqual(calls,['signed','timeclock:42']);
});
test('synthetic 901 cannot use a fake matching staging authorization',async()=>{
 const {access}=make({staff:{...session(),id:'901',employeeId:'901'},
   resolved:{id:'901',canLookup:true,permissionSource:'synthetic_staging_only'}});
 await assert.rejects(access.verifyBoundEmployee(req),denied);
});
test('revoked Timeclock employee and service outage cannot start enrollment',async()=>{
 for(const resolved of [null,{...canonical(),id:'901'},
   {...canonical(),permissionSource:'read_only'},
   {...canonical(),canLookup:false},
   Object.assign(Error('revoked'),{status:403})]){
  await assert.rejects(make({resolved}).access.verifyBoundEmployee(req),denied);
 }
 await assert.rejects(make({resolved:Error('network failed')}).access.verifyBoundEmployee(req),unavailable);
});
test('expired, disabled, mismatched or forged session fails before canonical read',async()=>{
 for(const staff of [
  {...session(),active:false},{...session(),id:'0'},
  {...session(),employeeId:'901'},
  {...session(),binding:'short'},
  {...session(),expiresAtMs:NOW}
 ]){
  const {access,calls}=make({staff});
  await assert.rejects(access.verifyBoundEmployee(req),denied);
  assert.deepEqual(calls,['signed']);
 }
 await assert.rejects(make().access.verifyBoundEmployee({
  signed:false,employeeId:'42',role:'owner'
 }),denied);
});
test('approver must have recent independent passkey-class authentication',async()=>{
 const strong={id:'8',active:true,method:'passkey',authenticatedAtMs:NOW-1000};
 const build=(manager,strongGrant=true)=>createCanonicalStaffFactorApprovalPolicy({
  now:()=>NOW,
  verifyStrongApprover:async()=>manager,
  canApproveEnrollment:async()=>strongGrant,
  canRecoverFactor:async()=>false
 });
 assert.deepEqual(await build(strong).verifyStrongApprover(req),strong);
 for(const manager of [
  {...strong,method:'totp'},{...strong,authenticatedAtMs:NOW-7*60_000},
  {...strong,authenticatedAtMs:NOW+1000},{...strong,id:'0'},
  {...strong,active:false}
 ])await assert.rejects(build(manager).verifyStrongApprover(req),denied);
 assert.equal(await build(strong,false).canApproveEnrollment({}),false);
 assert.equal(await build(strong).canRecoverFactor({}),false);
 assert.throws(()=>createCanonicalStaffFactorApprovalPolicy(),TypeError);
});
test('durable approval states remain sole gate to QR generation and confirmation',async()=>{
 let state='none';
 const adapters=createStaffApprovedEnrollmentAdapters({approvals:{
  status:async()=>({state}),
  start:async()=>state==='approved',
  allowConfirmation:async()=>state==='started',
  finish:async()=>state==='started'
 }});
 assert.equal(await adapters.authorizeSettings({request:req,action:'authenticator.enroll'}),false);
 assert.equal(await adapters.authorizeEnrollment({context:req,phase:'begin'}),false);
 state='approved';
 assert.equal(await adapters.authorizeSettings({request:req,action:'authenticator.enroll'}),true);
 assert.equal(await adapters.authorizeEnrollment({context:req,phase:'begin'}),true);
 state='started';
 assert.equal(await adapters.authorizeSettings({request:req,action:'authenticator.confirm'}),true);
 assert.equal(await adapters.authorizeEnrollment({context:req,phase:'confirm'}),true);
 assert.equal(await adapters.authorizeEnrollment({context:req,phase:'finish'}),true);
 assert.equal(await adapters.authorizeEnrollment({context:req,phase:'reset'}),false);
});
test('no enrollment, PIN replacement, credential copy or Owner promotion API exists',()=>{
 assert.deepEqual(Object.keys(make().access),['verifyBoundEmployee']);
 assert.throws(()=>createCanonicalStaffFactorSession(),TypeError);
});
