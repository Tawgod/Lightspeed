import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrimaryEmployeeSecurityReadiness} from '../services/security/primaryEmployeeSecurityReadiness.js';

const NOW=Date.parse('2026-11-09T18:00:00Z');
const denied=e=>e?.code==='HC_PRIMARY_EMPLOYEE_DENIED'&&e.status===403;
const unavailable=e=>e?.code==='HC_PRIMARY_EMPLOYEE_UNAVAILABLE'&&e.status===503;
const PRIMARY='42';
const context={signedStaffSession:true};
function setup({
  employee={id:PRIMARY,employeeId:PRIMARY,active:true,binding:'session-bound-primary-uuid-01',expiresAtMs:NOW+60_000},
  owner=true,proof={verified:true,employeeId:PRIMARY,method:'passkey',authenticatedAtMs:NOW-1000},
  factor={state:'not_enrolled'}
}={}){
 const events=[];
 const gate=createPrimaryEmployeeSecurityReadiness({
  now:()=>NOW,
  verifyBoundEmployee:async ctx=>{events.push('employee');if(ctx!==context)throw Error('invalid session');return employee;},
  checkOwnerAssignment:async ({employeeId})=>{events.push('owner:'+employeeId);return owner;},
  verifyPrimaryFactorProof:async ({employeeId})=>{events.push('proof:'+employeeId);return proof;},
  readPrimaryFactorStatus:async ({employeeId})=>{events.push('factor:'+employeeId);return factor;}
 });
 return {gate,events};
}
test('signed real Owner employee is inspected without copying synthetic factors',async()=>{
 const {gate,events}=setup();
 const result=await gate.inspect({context});
 assert.deepEqual(result,{
  employeeId:PRIMARY,employeeActive:true,independentlyVerifiedOwner:true,
  primaryAuthenticator:'not_enrolled',requiresSeparateEnrollment:true,
  readOnly:true,testIdentityTransferAllowed:false
 });
 assert.deepEqual(events,['employee','owner:42','proof:42','factor:42']);
 assert.equal(Object.isFrozen(result),true);
});
test('primary account with independently enrolled active factor reports no new enrollment required',async()=>{
 const {gate}=setup({factor:{state:'active'}});
 assert.equal((await gate.inspect({context})).requiresSeparateEnrollment,false);
});
test('untrusted caller employee identifiers and synthetic test session cannot select the target',async()=>{
 const {gate}=setup();
 await assert.rejects(gate.inspect({context:{...context,employeeId:PRIMARY}}),denied);
 const {gate:synthetic}=setup({employee:{id:'901',employeeId:'901',active:true,binding:'synthetic-session-binding-abc',expiresAtMs:NOW+60000}});
 await assert.rejects(synthetic.inspect({context}),denied);
});
test('expired, mismatched or disabled employee sessions deny before factor access',async()=>{
 const bad=[
  {id:PRIMARY,employeeId:PRIMARY,active:false,binding:'session-bound-primary-uuid-01',expiresAtMs:NOW+60000},
  {id:PRIMARY,employeeId:'901',active:true,binding:'session-bound-primary-uuid-01',expiresAtMs:NOW+60000},
  {id:PRIMARY,employeeId:PRIMARY,active:true,binding:'short',expiresAtMs:NOW+60000},
  {id:PRIMARY,employeeId:PRIMARY,active:true,binding:'session-bound-primary-uuid-01',expiresAtMs:NOW}
 ];
 for(const employee of bad){
  const {gate,events}=setup({employee});
  await assert.rejects(gate.inspect({context}),denied);
  assert.deepEqual(events,['employee']);
 }
});
test('Owner role never inferred from PIN, employee name, or browser-supplied role',async()=>{
 const {gate,events}=setup({owner:false});
 await assert.rejects(gate.inspect({context}),denied);
 assert.deepEqual(events,['employee','owner:42']);
});
test('synthetic factor proof for 901 or a TOTP-only proof cannot commission real Owner',async()=>{
 for(const proof of [
  {verified:true,employeeId:'901',method:'passkey',authenticatedAtMs:NOW-1000},
  {verified:true,employeeId:PRIMARY,method:'totp',authenticatedAtMs:NOW-1000},
  {verified:true,employeeId:PRIMARY,method:'passkey',authenticatedAtMs:NOW-6*60_000},
  {verified:false,employeeId:PRIMARY,method:'passkey',authenticatedAtMs:NOW-1000}
 ]){
  const {gate,events}=setup({proof});
  await assert.rejects(gate.inspect({context}),denied);
  assert.equal(events.includes('factor:42'),false);
 }
});
test('factor unavailable and unrecognized states fail closed',async()=>{
 for(const factor of [null,{state:'test-active'},{state:'copied'}]){
  await assert.rejects(setup({factor}).gate.inspect({context}),unavailable);
 }
});
test('no account write or grant adapter exists on the read-only service',()=>{
 const {gate}=setup();
 assert.deepEqual(Object.keys(gate),['inspect']);
 assert.throws(()=>createPrimaryEmployeeSecurityReadiness(),TypeError);
});
