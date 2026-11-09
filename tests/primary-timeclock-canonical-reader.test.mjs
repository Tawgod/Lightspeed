import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrimaryTimeclockCanonicalReader} from '../services/security/primaryTimeclockCanonicalReader.js';
import {createPrimaryEmployeeIdentityDiscovery} from '../services/security/primaryEmployeeIdentityDiscovery.js';

const NOW=Date.parse('2026-11-09T20:00:00Z');
const session={id:'42',employeeId:'42',active:true,
 binding:'canonical-bound-session-test-001',expiresAtMs:NOW+60000};
const denied=e=>e?.code==='HC_CANONICAL_EMPLOYEE_DENIED'&&e.status===403;
const unavailable=e=>e?.code==='HC_CANONICAL_EMPLOYEE_UNAVAILABLE'&&e.status===503;
function reader(authorize){
 return createPrimaryTimeclockCanonicalReader({timeclockIdentity:{authorize}});
}
test('canonical Timeclock authorize adapter resolves same active ID without role escalation',async()=>{
 const seen=[];
 const gate=reader(async id=>{
  seen.push(id);
  return {id:42,canLookup:true,canApprove:true,
   permissionSource:'timeclock_employee',role:null};
 });
 assert.deepEqual(await gate.verifyCanonicalTimeclockEmployee({employeeId:'42'}),{
  source:'timeclock',employeeId:'42',active:true
 });
 assert.deepEqual(seen,['42']);
 assert.deepEqual(Object.keys(gate),['verifyCanonicalTimeclockEmployee']);
});
test('existing Timeclock bridge denies revoked, mismatched or noncanonical records',async()=>{
 for(const result of [
  {id:42,canLookup:true,permissionSource:'synthetic_staging_only'},
  {id:901,canLookup:true,permissionSource:'timeclock_employee'},
  {id:42,canLookup:false,permissionSource:'timeclock_employee'},
  null
 ]) await assert.rejects(reader(async()=>result)
  .verifyCanonicalTimeclockEmployee({employeeId:'42'}),denied);
 for(const id of ['0','-1','abc','42/other','1e3'])await assert.rejects(
  reader(async()=>{throw Error('should not call Timeclock')})
   .verifyCanonicalTimeclockEmployee({employeeId:id}),denied);
});
test('Timeclock access revoked is denied; service outage remains unavailable',async()=>{
 await assert.rejects(reader(async()=>{throw Object.assign(Error('revoked'),{status:403});})
  .verifyCanonicalTimeclockEmployee({employeeId:'42'}),denied);
 await assert.rejects(reader(async()=>{throw Error('network unavailable');})
  .verifyCanonicalTimeclockEmployee({employeeId:'42'}),unavailable);
});
test('discovery consumes canonical Timeclock verification without copying factors',async()=>{
 const called=[];
 const canonicalReader=reader(async id=>{
  called.push('timeclock:'+id);
  return {id:'42',canLookup:true,permissionSource:'timeclock_employee'};
 });
 const discovery=createPrimaryEmployeeIdentityDiscovery({
  now:()=>NOW,
  verifyBoundEmployee:async()=>session,
  verifyCanonicalTimeclockEmployee:canonicalReader.verifyCanonicalTimeclockEmployee,
  checkOwnerAssignment:async({employeeId})=>{called.push('owner:'+employeeId);return false;}
 });
 const ready=await discovery.inspectIdentity({context:{signedStaffSession:true}});
 assert.equal(ready.employeeId,'42');
 assert.equal(ready.enrollmentAuthorized,false);
 assert.equal(ready.nextGate,'independent-owner-commissioning');
 assert.deepEqual(called,['timeclock:42','owner:42']);
});
test('adapter needs explicit trusted Timeclock backend client',()=>{
 assert.throws(()=>createPrimaryTimeclockCanonicalReader(),TypeError);
});
