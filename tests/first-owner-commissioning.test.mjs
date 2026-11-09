import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirstOwnerCommissioning} from '../services/security/firstOwnerCommissioning.js';

const NOW=Date.parse('2026-11-09T22:00:00Z');
const approvalId='01234567-89ab-4cde-8fab-0123456789ab';
const context={request:'signed'};
const employee={id:'42',employeeId:'42',active:true,
 binding:'bound-primary-employee-session-01',expiresAtMs:NOW+60000};
const approved=()=>({
 approval_id:approvalId,employee_id:'42',evidence_digest:'a'.repeat(64),
 independent_operator_ref:'verified-external-operator-1',
 approved_at:new Date(NOW-1000),expires_at:new Date(NOW+60000),consumed_at:null
});
const denied=e=>e?.status===403&&e.code==='HC_FIRST_OWNER_DENIED';
const unavailable=e=>e?.status===503&&e.code==='HC_FIRST_OWNER_UNAVAILABLE';
function setup({identity=employee,evidence=true,row=approved(),owner=false,
  failOn=null}={}){
 const calls=[];
 const svc=createFirstOwnerCommissioning({
  now:()=>NOW,
  verifySignedCanonicalEmployee:async ctx=>{
   calls.push('identity');
   if(ctx!==context)throw Error('bad session');
   return identity;
  },
  verifyIndependentEvidence:async data=>{
   calls.push('independent-evidence');
   assert.equal(data.employeeId,'42');
   assert.equal(data.approvalId,approvalId);
   return evidence;
  }
 });
 const client={query:async(sql,params)=>{
  const s=sql.trim();
  if(s.startsWith('SELECT approval_id')){calls.push('lock-approval');return {rowCount:row?1:0,rows:row?[row]:[]};}
  if(s.startsWith('SELECT employee_id')){calls.push('check-owner');return {rowCount:owner?1:0,rows:owner?[{employee_id:'99'}]:[]};}
  if(s.startsWith('UPDATE hc_owner_commissioning')){calls.push('consume');return {rowCount:1,rows:[{approval_id:approvalId}]};}
  if(s.startsWith('INSERT INTO hc_admin_principals')){calls.push('owner-insert');return {rowCount:1};}
  if(s.startsWith('INSERT INTO hc_owner_commissioning_events')){calls.push('audit');return {rowCount:1};}
  if(failOn&&s.startsWith(failOn))throw Error('DB failed');
  throw Error('Unexpected query: '+s);
 }};
 return {svc,client,calls};
}
const args=client=>({context,client,employeeId:'42',credentialId:'passkey-credential-verified-12345'});
test('one-use independently attested Owner is committed with verified passkey transaction',async()=>{
 const {svc,client,calls}=setup();
 await svc.commitRegistrationGrant(args(client));
 assert.deepEqual(calls,['identity','lock-approval','independent-evidence',
  'check-owner','consume','owner-insert','audit']);
 assert.deepEqual(Object.keys(svc),['commitRegistrationGrant']);
});
test('no real Owner appointment from PIN, client-selected ID or synthetic proof',async()=>{
 for(const bad of [
  {identity:{...employee,active:false}},
  {identity:{...employee,id:'901'}},
  {identity:{...employee,expiresAtMs:NOW}},
  {evidence:false}
 ]){
  const {svc,client,calls}=setup(bad);
  await assert.rejects(svc.commitRegistrationGrant(args(client)),denied);
  assert.equal(calls.includes('owner-insert'),false);
 }
});
test('expired, consumed, malformed or missing operator authorization never creates Owner',async()=>{
 for(const row of [
  null,{...approved(),consumed_at:new Date(NOW-1)},
  {...approved(),expires_at:new Date(NOW-1)},
  {...approved(),employee_id:'901'},
  {...approved(),evidence_digest:'fake'},
  {...approved(),independent_operator_ref:'x'}
 ]){
  const {svc,client,calls}=setup({row});
  await assert.rejects(svc.commitRegistrationGrant(args(client)),denied);
  assert.equal(calls.includes('owner-insert'),false);
 }
});
test('already commissioned Owner blocks a second Owner',async()=>{
 const {svc,client,calls}=setup({owner:true});
 await assert.rejects(svc.commitRegistrationGrant(args(client)),denied);
 assert.equal(calls.includes('consume'),false);
});
test('unavailable approval store is fail-closed',async()=>{
 const svc=createFirstOwnerCommissioning({
  now:()=>NOW,
  verifySignedCanonicalEmployee:async()=>employee,
  verifyIndependentEvidence:async()=>true
 });
 await assert.rejects(svc.commitRegistrationGrant(args({
  query:async()=>{throw Error('database down');}
 })),unavailable);
});
test('no client API to mint an approval and no unverified environment fallback',async()=>{
 assert.throws(()=>createFirstOwnerCommissioning(),TypeError);
 const {svc,client}=setup();
 await assert.rejects(svc.commitRegistrationGrant({...args(client),employeeId:'901'}),denied);
 await assert.rejects(svc.commitRegistrationGrant({...args(client),credentialId:'x'}),denied);
});
