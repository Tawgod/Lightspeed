import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrimaryEmployeeIdentityDiscovery} from '../services/security/primaryEmployeeIdentityDiscovery.js';

const NOW=Date.parse('2026-11-09T19:00:00Z');
const context=Object.freeze({session:'signed'});
const session=()=>({id:'42',employeeId:'42',active:true,
  binding:'server-signed-bound-session-identity',expiresAtMs:NOW+60000});
const canonical=()=>({source:'timeclock',employeeId:'42',active:true});
const denied=e=>e?.status===403&&e.code==='HC_PRIMARY_IDENTITY_DENIED';
const unavailable=e=>e?.status===503&&e.code==='HC_PRIMARY_IDENTITY_UNAVAILABLE';
function build({getSession=async()=>session(),getCanonical=async()=>canonical(),
               getOwner=async()=>false}={}){
 const calls=[];
 const check=createPrimaryEmployeeIdentityDiscovery({
  now:()=>NOW,
  verifyBoundEmployee:async request=>{
   calls.push('session');if(request!==context)throw Error('Invalid token');
   return getSession();
  },
  verifyCanonicalTimeclockEmployee:async ({employeeId})=>{
   calls.push('canonical:'+employeeId);return getCanonical(employeeId);
  },
  checkOwnerAssignment:async ({employeeId})=>{
   calls.push('owner:'+employeeId);return getOwner(employeeId);
  }
 });
 return {check,calls};
}
test('existing primary Timeclock identity is discovered without a strong factor or privileges',async()=>{
 const {check,calls}=build();
 const result=await check.inspectIdentity({context});
 assert.deepEqual(result,{
  employeeId:'42',currentEmployee:true,canonicalTimeclockIdentityVerified:true,
  independentlyAppointedOwner:false,nextGate:'independent-owner-commissioning',
  primaryFactorEnrolled:'not_checked',enrollmentAuthorized:false,
  readOnly:true,syntheticFactorTransferAllowed:false
 });
 assert.deepEqual(calls,['session','canonical:42','owner:42']);
 assert.equal(Object.isFrozen(result),true);
});
test('pre-appointed Owner is identified but still does not receive enrollment rights',async()=>{
 const {check}=build({getOwner:async()=>true});
 const result=await check.inspectIdentity({context});
 assert.equal(result.independentlyAppointedOwner,true);
 assert.equal(result.nextGate,'independent-primary-factor-verification');
 assert.equal(result.enrollmentAuthorized,false);
});
test('caller-selected employee identity and raw PIN are never accepted',async()=>{
 const {check}=build();
 await assert.rejects(check.inspectIdentity({context:{...context,employeeId:'42',role:'owner'}}),denied);
 await assert.rejects(check.inspectIdentity({context:{pin:'1234'}}),denied);
 await assert.rejects(check.inspectIdentity({}),denied);
});
test('inactive, expired, mismatched or malformed signed sessions deny before Timeclock lookup',async()=>{
 const bad=[
  {...session(),active:false},
  {...session(),employeeId:'901'},
  {...session(),expiresAtMs:NOW},
  {...session(),binding:'short'},
  {...session(),id:'0'},
  {...session(),id:'42',employeeId:'42',expiresAtMs:'tomorrow'}
 ];
 for(const s of bad){
  const {check,calls}=build({getSession:async()=>s});
  await assert.rejects(check.inspectIdentity({context}),denied);
  assert.deepEqual(calls,['session']);
 }
});
test('test identity 901 without a matching canonical Timeclock record cannot commission',async()=>{
 const {check,calls}=build({
  getSession:async()=>({...session(),id:'901',employeeId:'901'}),
  getCanonical:async()=>({source:'synthetic_staging_only',employeeId:'901',active:true})
 });
 await assert.rejects(check.inspectIdentity({context}),denied);
 assert.deepEqual(calls,['session','canonical:901']);
});
test('canonical record must match the session and be currently active',async()=>{
 for(const record of [
  {...canonical(),employeeId:'901'},
  {...canonical(),source:'synthetic_staging_only'},
  {...canonical(),active:false},
  null,
  {employeeId:'42',active:true}
 ]){
  const {check,calls}=build({getCanonical:async()=>record});
  await assert.rejects(check.inspectIdentity({context}),denied);
  assert.equal(calls.some(x=>x.startsWith('owner:')),false);
 }
});
test('canonical backend or Owner grant read failure denies all readiness claims',async()=>{
 await assert.rejects(build({getCanonical:async()=>{throw Error('offline')}})
   .check.inspectIdentity({context}),unavailable);
 await assert.rejects(build({getOwner:async()=>{throw Error('DB down')}})
   .check.inspectIdentity({context}),unavailable);
 await assert.rejects(build({getOwner:async()=>null})
   .check.inspectIdentity({context}),unavailable);
});
test('discovery exports no mutation, Owner appointment, enrollment or credential transfer',()=>{
 const {check}=build();
 assert.deepEqual(Object.keys(check),['inspectIdentity']);
 assert.throws(()=>createPrimaryEmployeeIdentityDiscovery(),TypeError);
});
