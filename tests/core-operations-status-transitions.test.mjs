import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { createStaffAccessBaseline } from '../services/security/staffAccessBaseline.js';
import { createCoreOperationsRouteAdmission } from '../services/security/coreOperationsRouteAdmission.js';
import { createSpecialOrdersRouter } from '../special-orders.js';
import {
  STATUS_PROGRESS_OPERATION, STATUS_SENSITIVE_OPERATION, STATUS_POLICY_VERSION,
  ROUTINE_STATUSES, SENSITIVE_STATUSES, KNOWN_STATUSES,
  classifyRequestedStatus, permitsLockedStatusTransition
} from '../services/security/coreOperationsStatusTransitions.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const deny = e => e?.code === 'HC_CORE_OPERATIONS_FORBIDDEN' && e.status === 403;
const guardedStatusApproval = Object.freeze({
  source:'special-orders.js', method:'PATCH', path:'/items/:id/status',
  audience:'employee', operation:STATUS_SENSITIVE_OPERATION,
  statusPolicy:STATUS_POLICY_VERSION
});
const headers = proof => ({
  authorization:'Bearer signed-employee',
  'x-fixture-proof':proof,
  'x-hc-role':'Owner', 'x-hobby-corner-key':'claimed-admin-key'
});
const request = (target, proof='station') => ({
  method:'PATCH', path:'/items/51/status',
  body:{status:target,changed_by:'Owner'}, headers:headers(proof),
  get(name){return this.headers[String(name).toLowerCase()];}
});
function staffAccess(grants) {
  return createStaffAccessBaseline({
    now:()=>NOW,
    verifyEmployeeSession:async req => req.get('authorization')==='Bearer signed-employee'
      ? {id:'42',active:true,clockedIn:false}:null,
    verifyWorkstation:async req => req.get('x-fixture-proof')==='station'
      ? {verified:true,deviceId:'registered-kiosk',expiresAtMs:NOW+30_000}:null,
    verifyStepUp:async req => ['passkey','totp'].includes(req.get('x-fixture-proof'))
      ? {verified:true,employeeId:'42',method:req.get('x-fixture-proof'),
        authenticatedAtMs:NOW-1000}:null,
    checkPermission:async ({operation})=>grants.has(operation)
  });
}
function gate(grants) {
  return createCoreOperationsRouteAdmission({
    approvedRoutes:[guardedStatusApproval],
    staffAccess:staffAccess(new Set(grants))
  });
}

test('known status vocabulary matches existing business route, with a conservative routine subset',()=>{
  assert.equal(KNOWN_STATUSES.length,10);
  assert.equal(new Set(KNOWN_STATUSES).size,10);
  assert.deepEqual([...KNOWN_STATUSES].sort(),
    [...ROUTINE_STATUSES,...SENSITIVE_STATUSES].sort());
  assert.deepEqual([...ROUTINE_STATUSES].sort(),['BACKORDERED','OOS','READY_TO_ORDER']);
  for(const value of KNOWN_STATUSES){
    assert.equal(classifyRequestedStatus({status:value.toLowerCase()})?.status,value);
  }
  // Catch accidental drift with the actual business statuses in special-orders.js.
  const source=readFileSync(new URL('../special-orders.js',import.meta.url),'utf8');
  const match=source.match(/const VALID_STATUSES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match,'Business route status enumeration changed');
  const businessStatuses=[...match[1].matchAll(/'([A-Z_]+)'/g)].map(x=>x[1]).sort();
  assert.deepEqual(businessStatuses,[...KNOWN_STATUSES].sort());
});

test('target classifier accepts only an owned string known status; fails closed for coercion or odd values',()=>{
  const invalid=[null,undefined,'',[],{status:3},{status:['CANCELLED']},
    {status:'  OOS  '},{status:'DONE'},{status:'__proto__'},
    {status:'OOS'.repeat(20)},Object.create({status:'OOS'})];
  for(const value of invalid){
    assert.equal(classifyRequestedStatus(value),null,String(value));
  }
  assert.equal(classifyRequestedStatus({status:'oos'}).operation,STATUS_PROGRESS_OPERATION);
  assert.equal(classifyRequestedStatus({status:'CANCELLED'}).operation,STATUS_SENSITIVE_OPERATION);
  assert.equal(classifyRequestedStatus({status:'COMPLETED'}).operation,STATUS_SENSITIVE_OPERATION);
  assert.equal(classifyRequestedStatus({status:'RECEIVED'}).operation,STATUS_SENSITIVE_OPERATION);
  assert.equal(classifyRequestedStatus({status:'ORDERED'}).operation,STATUS_SENSITIVE_OPERATION);
});

test('all routine destinations require existing routine source under DB row lock',()=>{
  const admission={principal:'employee',identityId:'42',
    operation:STATUS_PROGRESS_OPERATION,statusTarget:'OOS'};
  for(const prior of ROUTINE_STATUSES)
    assert.equal(permitsLockedStatusTransition(admission,prior,'OOS'),true,prior);
  for(const prior of SENSITIVE_STATUSES)
    assert.equal(permitsLockedStatusTransition(admission,prior,'OOS'),false,prior);
  for(const target of ['CANCELLED','ORDERED','RECEIVED','PREORDER','COMPLETED','HELD',
    'CUSTOMER_NOTIFIED','READY_TO_ORDER','BACKORDERED']) {
    assert.equal(permitsLockedStatusTransition(admission,'OOS',target),false,target);
  }
  for(const malformed of [null,{}, {...admission,statusTarget:'BACKORDERED'},
    {...admission,identityId:'Owner'}, {...admission,principal:'service'},
    {...admission,operation:'special-orders.notes.write'}]){
    assert.equal(permitsLockedStatusTransition(malformed,'OOS','OOS'),false);
  }
});

test('sensitive target requires exact strong action; never lowered by origin',()=>{
  const strong={principal:'employee',identityId:'42',
    operation:STATUS_SENSITIVE_OPERATION,statusTarget:'CANCELLED'};
  for(const prior of KNOWN_STATUSES) {
    assert.equal(permitsLockedStatusTransition(strong,prior,'CANCELLED'),true,prior);
  }
  assert.equal(permitsLockedStatusTransition(strong,'ORDERED','OOS'),false);
  assert.equal(permitsLockedStatusTransition({...strong,statusTarget:'RECEIVED'},
    'ORDERED','CANCELLED'),false);
});

test('routine permission never grants privileged completion/cancellation, even with forged Owner role',async()=>{
  const policy=gate([STATUS_PROGRESS_OPERATION]);
  for(const target of ROUTINE_STATUSES) {
    const admitted=await policy.authorize({request:request(target,'station')});
    assert.equal(admitted.operation,STATUS_PROGRESS_OPERATION);
    assert.equal(admitted.statusTarget,target);
    assert.equal(admitted.identityId,'42');
  }
  for(const target of SENSITIVE_STATUSES) {
    await assert.rejects(policy.authorize({request:request(target,'passkey')}),deny,target);
  }
  await assert.rejects(policy.authorize({request:request('CANCELLED','station')}),deny);
  await assert.rejects(policy.authorize({request:request('CANCELLED','totp')}),deny);
  await assert.rejects(policy.authorize({request:request('OOS','missing')}),deny);
});

test('strong grant and current passkey allow protected targets but routine target still needs its own grant',async()=>{
  const policy=gate([STATUS_SENSITIVE_OPERATION]);
  for(const target of SENSITIVE_STATUSES) {
    const result=await policy.authorize({request:request(target,'passkey')});
    assert.equal(result.operation,STATUS_SENSITIVE_OPERATION);
    assert.equal(result.statusTarget,target);
    assert.equal(result.assurance,'step-up');
    await assert.rejects(policy.authorize({request:request(target,'station')}),deny,target);
    await assert.rejects(policy.authorize({request:request(target,'totp')}),deny,target);
  }
  await assert.rejects(policy.authorize({request:request('OOS','passkey')}),deny);
  const noGrants=gate([]);
  await assert.rejects(noGrants.authorize({request:request('CANCELLED','passkey')}),deny);
});

test('unknown payloads deny before staff authorization, and review-only scopes do not approve the route',async()=>{
  const policy=gate([STATUS_PROGRESS_OPERATION,STATUS_SENSITIVE_OPERATION]);
  for(const body of [{status:'FAKE'},{status:[]},{status:null},
    {status:{toString:()=> 'CANCELLED'}},{status:'OOS '},[]]){
    await assert.rejects(policy.authorize({request:{...request('OOS'),body}}),deny);
  }
  const empty=createCoreOperationsRouteAdmission({
    staffAccess:staffAccess(new Set([STATUS_PROGRESS_OPERATION,STATUS_SENSITIVE_OPERATION]))
  });
  await assert.rejects(empty.authorize({request:request('OOS','passkey')}),deny);
});

test('status policy cannot be applied to a different route, service caller or arbitrary static routine scope',()=>{
  const factory=approvedRoutes=>()=>createCoreOperationsRouteAdmission({approvedRoutes});
  assert.throws(factory([{...guardedStatusApproval,path:'/items/:id/notes'}]),TypeError);
  assert.throws(factory([{...guardedStatusApproval,method:'GET'}]),TypeError);
  assert.throws(factory([{...guardedStatusApproval,audience:'service',
    operation:'service.status.write'}]),TypeError);
  assert.throws(factory([{...guardedStatusApproval,statusPolicy:'ignore-lock'}]),TypeError);
  assert.throws(factory([{...guardedStatusApproval,operation:STATUS_PROGRESS_OPERATION}]),TypeError);
  assert.throws(factory([{source:'special-orders.js',method:'PATCH',path:'/items/:id/status',
    audience:'employee',operation:STATUS_PROGRESS_OPERATION}]),TypeError);
});

test('real Special Orders router enforces the explicit target operation before DB access',async()=>{
  const app=express();
  app.use(express.json());
  app.use('/api/special-orders',createSpecialOrdersRouter({
    adminKey:'fixture-only',
    coreOperationsAdmission:gate([STATUS_PROGRESS_OPERATION,STATUS_SENSITIVE_OPERATION])
  }));
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  try{
    const uri='http://127.0.0.1:'+server.address().port+'/api/special-orders/items/51/status';
    async function call(status,proof){
      const r=await fetch(uri,{method:'PATCH',headers:{
        ...headers(proof),'Content-Type':'application/json'
      },body:JSON.stringify({status,changed_by:'owner'})});
      const data=await r.json();return {status:r.status,body:data};
    }
    assert.equal((await call('OOS','station')).status,503); // requireDb, not a bypass
    assert.equal((await call('COMPLETED','station')).status,403);
    assert.equal((await call('CANCELLED','totp')).status,403);
    assert.equal((await call('CANCELLED','passkey')).status,503);
    assert.equal((await call('not-a-status','passkey')).status,403);
    assert.equal((await call('OOS','passkey')).status,503); // grant for routine too
    const legacy=await fetch(uri,{method:'PATCH',headers:{
      'Content-Type':'application/json','x-hobby-corner-key':'fixture-only'
    },body:JSON.stringify({status:'OOS'})});
    assert.equal(legacy.status,403);
    await legacy.text();
  }finally{
    const closed=new Promise(resolve=>server.close(resolve));
    server.closeAllConnections?.();
    await closed;
  }
});

test('locked prior-state check occurs before the SQL update on actual handler',()=>{
  const source=readFileSync(new URL('../special-orders.js',import.meta.url),'utf8');
  const start=source.indexOf("router.patch('/items/:id/status'");
  const end=source.indexOf("async function syncLightspeedSuppliers",start);
  assert.ok(start>=0&&end>start);
  const handler=source.slice(start,end);
  const lock=handler.indexOf('FOR UPDATE');
  const check=handler.indexOf('permitsLockedStatusTransition(');
  const write=handler.indexOf('UPDATE special_order_items SET status=$1');
  assert.ok(lock>=0 && check>lock && write>check,'Source validation must remain under the row lock before any update');
  assert.match(handler,/coreOperationsAdmission != null/);
  assert.match(handler,/return res\.status\(403\)/);
});
