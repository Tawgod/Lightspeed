import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalTransactionM5 } from '../services/lightspeed/localTransactionM5.js';
import { fingerprintLightspeedPayload as fingerprint } from '../services/lightspeed/idempotency.js';
import { withDisposableCorePg } from './fixtures/coreDisposablePg.mjs';

const options={skip:!process.env.HC_TEST_DATABASE_URL?'Disposable PostgreSQL required':false};
const actor={type:'employee',id:'fixture-A'};
const command={scope:'test:shop:restock.confirm',key:'fixture-001',actor,operations:['restock.confirm'],context:{tool:'Inventory'},payload:{id:'batch-1'},apply:async(tx,p)=>{
  await tx.writeDomain(p.id,{quantity:'1'});
  const event={id:p.id,kind:'inventory.review.requested'};
  await tx.enqueue({id:p.id,fingerprint:fingerprint(event),record:event});
  return {id:p.id,privateNote:'synthetic'};
},projectResult:r=>({id:r.id})};
const runFor=(f,options={})=>createLocalTransactionM5({...f,authorize:async()=>true,...options});

test('actor-bound replay crosses tools but not actors; fresh projection on every result',options,async()=>withDisposableCorePg(async f=>{
  const run=runFor(f);
  const a=await run(command);
  assert.deepEqual(a,{replayed:false,result:{id:'batch-1'}});
  const b=await run({...command,context:{tool:'Scanner'},projectResult:r=>({id:r.id,canView:false})});
  assert.deepEqual(b,{replayed:true,result:{id:'batch-1',canView:false}});
  await assert.rejects(run({...command,actor:{type:'employee',id:'fixture-B'}}),e=>e.code==='CORE_KEY_CONFLICT');
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:1});
}));
test('concurrent actor-bound requests commit once and audit cannot be changed',options,async()=>withDisposableCorePg(async f=>{
  const run=runFor(f);
  const results=await Promise.all([run(command),run(command)]);
  assert.equal(results.filter(r=>r.replayed).length,1);
  for(const tamper of [f.attemptAuditUpdate,f.attemptAuditDelete,f.attemptAuditTruncate])await assert.rejects(tamper(),/immutable/);
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:1});
}));
test('lost commit acknowledgement resolves committed result without repeating effect',options,async()=>withDisposableCorePg(async f=>{
  let executions=0;
  const run=runFor(f,{transaction:async fn=>{await f.transaction(fn);throw Object.assign(Error('synthetic lost ack'),{code:'CORE_COMMIT_UNKNOWN'});}});
  const result=await run({...command,apply:async(...a)=>{executions++;return command.apply(...a);}});
  assert.equal(result.replayed,true);assert.equal(executions,1);
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:1});
}));
test('unresolved commit uncertainty never retries automatically or claims rollback',options,async()=>withDisposableCorePg(async f=>{
  let attempts=0;
  const run=runFor(f,{transaction:async()=>{attempts++;throw Object.assign(Error('synthetic uncertainty'),{code:'CORE_COMMIT_UNKNOWN'});}});
  await assert.rejects(run(command),e=>e.code==='CORE_COMMIT_UNKNOWN');
  assert.equal(attempts,1);assert.deepEqual(await f.counts(),{commands:0,domain:0,outbox:0,audit:0});
}));
test('outbox duplicate event is idempotent; changed event rolls back entire command',options,async()=>withDisposableCorePg(async f=>{
  const run=runFor(f);await run(command);
  const event={id:'batch-1',kind:'inventory.review.requested'};
  const out=await run({...command,key:'fixture-002',payload:{id:'batch-2'},apply:async(tx,p)=>{
    await tx.writeDomain(p.id,{});return tx.enqueue({id:'batch-1',fingerprint:fingerprint(event),record:event});
  },projectResult:r=>r});
  assert.equal(out.result.duplicate,true);
  await assert.rejects(run({...command,key:'fixture-003',payload:{id:'batch-3'},apply:async(tx,p)=>{
    await tx.writeDomain(p.id,{});const changed={...event,kind:'changed'};return tx.enqueue({id:'batch-1',fingerprint:fingerprint(changed),record:changed});
  }}),e=>e.code==='CORE_OUTBOX_CONFLICT');
  assert.deepEqual(await f.counts(),{commands:2,domain:2,outbox:1,audit:2});
}));
test('fresh authorization denies replay and after-commit projection; effect remains committed',options,async()=>withDisposableCorePg(async f=>{
  let checks=0;
  const run=runFor(f,{authorize:async()=>++checks<3});
  await assert.rejects(run(command),e=>e.code==='CORE_FORBIDDEN');
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:2});
  await assert.rejects(run(command),e=>e.code==='CORE_FORBIDDEN');
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:3});
}));
test('projection failure after commit does not re-execute effect on authorized replay',options,async()=>withDisposableCorePg(async f=>{
  const run=runFor(f);
  await assert.rejects(run({...command,projectResult:()=>{throw Error('projection failed');}}),/projection failed/);
  assert.deepEqual(await run(command),{replayed:true,result:{id:'batch-1'}});
  assert.deepEqual(await f.counts(),{commands:1,domain:1,outbox:1,audit:1});
}));
test('outbox failure rolls back domain and command; invalid production scope never opens transaction',options,async()=>withDisposableCorePg(async f=>{
  const run=runFor(f);
  await assert.rejects(run({...command,scope:'production:shop:restock.confirm'}),TypeError);
  await assert.rejects(run({...command,apply:async(tx,p)=>{await tx.writeDomain(p.id,{});throw Error('fixture outbox failure');}}));
  assert.deepEqual(await f.counts(),{commands:0,domain:0,outbox:0,audit:0});
}));
