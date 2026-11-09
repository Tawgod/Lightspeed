import test from 'node:test';
import assert from 'node:assert/strict';
import {createIndependentPrimaryEnrollmentApproval} from '../services/security/independentPrimaryEnrollmentApproval.js';

const NOW=Date.parse('2026-11-09T22:00:00Z');
const request={session:'verified'};
const canonical=id=>({source:'timeclock',active:true,employeeId:id});
const manager={id:'17',active:true,method:'passkey',authenticatedAtMs:NOW-1000};
const target={id:'42',active:true,binding:'primary-signed-session-binding',expiresAtMs:NOW+60000};
const denied=e=>e?.code==='HC_PRIMARY_APPROVER_DENIED'&&e?.status===403;
const unavailable=e=>e?.code==='HC_PRIMARY_APPROVER_UNAVAILABLE'&&e?.status===503;
function make({
  proof=manager,grant=true,lookup=async id=>canonical(id)
}={}){
 const calls=[];
 const policy=createIndependentPrimaryEnrollmentApproval({
  now:()=>NOW,
  verifyStrongApprover:async context=>{calls.push('proof');if(context!==request)throw Error('wrong session');return proof;},
  verifyCanonicalTimeclockEmployee:async ({employeeId})=>{
    calls.push('canonical:'+employeeId);return lookup(employeeId);
  },
  canApproveEnrollment:async params=>{calls.push('grant:'+params.approverId+':'+params.employeeId);return grant;}
 });
 return {policy,calls};
}
test('fresh independent manager with canonical Timeclock identity and exact grant may approve other employee',async()=>{
 const {policy,calls}=make();
 assert.equal(await policy.canApprove({context:request,approverId:'17',employeeId:'42',operation:'staff.authenticator.enroll'}),true);
 assert.deepEqual(calls,['proof','canonical:17','canonical:42','grant:17:42']);
});
test('the first Owner cannot approve their own live enrollment',async()=>{
 const {policy,calls}=make();
 assert.equal(await policy.canApprove({context:request,approverId:'17',employeeId:'17',operation:'staff.authenticator.enroll'}),false);
 assert.deepEqual(calls,[]);
});
test('a staging synthetic manager or a TOTP-only manager never approves a live employee',async()=>{
 for(const proof of [{...manager,id:'901'}, {...manager,method:'totp'}, {...manager,authenticatedAtMs:NOW-600000},
  {...manager,active:false}, {...manager,authenticatedAtMs:NOW+1000}]){
  const {policy}=make({proof,lookup:async id=>id==='901'?{source:'synthetic_staging_only',active:true,employeeId:id}:canonical(id)});
  assert.equal(await policy.canApprove({context:request,approverId:String(proof.id),employeeId:'42',operation:'staff.authenticator.enroll'}),false);
 }
});
test('wrong actor, missing grant, inactive or mismatched target denies',async()=>{
 const params={context:request,approverId:'17',employeeId:'42',operation:'staff.authenticator.enroll'};
 assert.equal(await make().policy.canApprove({...params,approverId:'18'}),false);
 assert.equal(await make({grant:false}).policy.canApprove(params),false);
 for(const lookup of [
  async id=>id==='42'?{source:'timeclock',active:false,employeeId:id}:canonical(id),
  async id=>id==='17'?{source:'test',active:true,employeeId:id}:canonical(id),
  async id=>id==='42'?{source:'timeclock',active:true,employeeId:'901'}:canonical(id),
  async()=>{throw Error('Timeclock offline');}
 ])assert.equal(await make({lookup}).policy.canApprove(params),false);
});
test('read-only readiness identifies missing independent approver without granting Owner or enrollment',async()=>{
 const {policy}=make();
 const preflight={context:request,verifySignedTarget:async()=>target,
   hasIndependentApprover:async()=>false};
 const status=await policy.preflight(preflight);
 assert.deepEqual(status,{
  employeeId:'42',canonicalIdentityVerified:true,independentApproverAvailable:false,
  nextGate:'independent-owner-commissioning',enrollmentAuthorized:false,readOnly:true
 });
 assert.equal(Object.isFrozen(status),true);
 const ready=await policy.preflight({...preflight,hasIndependentApprover:async()=>true});
 assert.equal(ready.nextGate,'approved-enrollment-request');
 assert.equal(ready.enrollmentAuthorized,false);
});
test('readiness refuses synthetic or revoked primary accounts and inaccurate manager coverage',async()=>{
 const {policy}=make();
 const base={context:request,verifySignedTarget:async()=>target,hasIndependentApprover:async()=>false};
 for(const v of [
  {...target,active:false},{...target,expiresAtMs:NOW},{...target,id:'0'},
  {...target,binding:''}
 ])await assert.rejects(policy.preflight({...base,verifySignedTarget:async()=>v}),denied);
 for(const v of [null,'yes',undefined])await assert.rejects(
  policy.preflight({...base,hasIndependentApprover:async()=>v}),unavailable);
 await assert.rejects(policy.preflight({...base,hasIndependentApprover:async()=>{throw Error('DB offline');}}),unavailable);
 const synthetic=make({lookup:async id=>id==='901'?{source:'synthetic_staging_only',active:true,employeeId:id}:canonical(id)});
 await assert.rejects(synthetic.policy.preflight({...base,verifySignedTarget:async()=>({...target,id:'901'})}),denied);
});
test('no grant writers, PIN migration or factor setup on preflight policy',()=>{
 assert.deepEqual(Object.keys(make().policy),['verifyApprover','canApprove','preflight']);
 assert.throws(()=>createIndependentPrimaryEnrollmentApproval(),TypeError);
});
