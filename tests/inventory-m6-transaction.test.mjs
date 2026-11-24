import test from 'node:test';
import assert from 'node:assert/strict';
import { planCountObservation, planRestockConfirmation, planReasonRevision } from '../services/lightspeed/inventoryPersistence.js';

// TEST ONLY: proposed seam, not a Security or Core implementation.
// Synchronous transaction double; no network, DB or runtime imports.
const channels=['inventory','backroom','scanner','import','automation','direct-api','indirect'];
const now='2026-11-24T10:30:00.000Z', before='2026-11-24T10:29:00.000Z';
const key={outletId:'01',productId:'0001',variantId:null};
const actorId='fixture-E1';
const reason={code:'missing',label:'Missing',revision:1,active:true,requiresNote:false,reviewFlag:'possible_shortage',appliesTo:['zero','partial']};
const locations=[{locationId:'S',outletId:'01',shelfCode:'S',area:'Storage',kind:'storage',active:true,labelDescription:'S'},{locationId:'F',outletId:'01',shelfCode:'F',area:'Floor',kind:'floor',active:true,labelDescription:'F'}];
const expected={...key,lineId:'L1',fromLocationId:'S',toLocationId:'F',plannedQuantity:4};
const task={taskId:'T1',version:'v1',state:'open',lines:[expected]};
const session={sessionId:'C1',state:'open',openedAt:'2026-11-24T10:00:00.000Z',outletId:'01'};
const countRequest={...key,scanId:'scan1',countMode:'full-outlet',countedQuantity:'3',scannedAt:before};
const restockRequest={taskVersion:'v1',batchId:'B1',lines:[{...expected,movedQuantity:0,reasonCode:'missing',confirmedAt:before}]};
function harness(authorize) {
  let state={entries:[],reviews:[],outbox:[],audit:[]};
  const specs={
    'count.observe': {resource:session.sessionId,build:r=>planCountObservation({session,request:r,actorId,recordedAt:now})},
    'restock.confirm': {resource:task.taskId,build:r=>planRestockConfirmation({task,request:r,locations,reasons:[reason],actorId,recordedAt:now})},
    'reason.revise': {resource:reason.code,build:r=>planReasonRevision({current:reason,next:r,actorId,recordedAt:now})}
  };
  function run(operation,request,channel,{failOutbox=false,beforeCommit=()=>{}}={}) {
    const spec=specs[operation];
    if (!spec || !channels.includes(channel)) throw Error('denied');
    const context={operation,resource:spec.resource,actorId,environment:'fixture',channel};
    const check=()=>{if(authorize(context)!==true)throw Error('denied');};
    check();
    // Detach client payload before planning; JSON ordering is fixed by these fixtures.
    const detached=structuredClone(request);
    const plan=spec.build(detached);
    if(plan.status!=='planned'||plan.executable!==false)throw Error('invalid plan');
    const identity=JSON.stringify([operation,plan.identity]);
    const payload=JSON.stringify(detached);
    const previous=state.entries.find(e=>e.identity===identity);
    if(previous){if(previous.payload!==payload)throw Error('conflict');return {replayed:true};}
    if(operation==='restock.confirm'&&state.entries.some(e=>e.plan.records.confirmation?.batchId===plan.records.confirmation.batchId))throw Error('duplicate batch');
    const draft=structuredClone(state);
    draft.entries.push({identity,payload,plan});
    draft.reviews.push(...(plan.records.reviews??[]));
    if(failOutbox)throw Error('outbox failed');
    draft.outbox.push(...(plan.records.outbox??[]));
    draft.audit.push({operation,resource:spec.resource,actorId});
    beforeCommit();
    check(); // queued/indirect or revoked grant must be checked again
    state=draft;
    return {replayed:false};
  }
  return {run,read:()=>structuredClone(state)};
}
test('all entrypoints deny the same underlying operation before recording anything',()=>{
  for(const [operation,request] of [['count.observe',countRequest],['restock.confirm',restockRequest],['reason.revise',{...reason,revision:2}]]) {
    const h=harness(c=>c.operation!==operation);
    for(const channel of channels)assert.throws(()=>h.run(operation,request,channel),/denied/);
    assert.deepEqual(h.read(),{entries:[],reviews:[],outbox:[],audit:[]});
  }
});
test('missing, ambiguous or unavailable synthetic decisions deny',()=>{
  for(const decision of [()=>undefined,()=>({allowed:true}),()=>{throw Error('unavailable');}]) {
    const h=harness(decision);assert.throws(()=>h.run('count.observe',countRequest,'import'));assert.equal(h.read().entries.length,0);
  }
});
test('grant revoked between planning and commit rolls back confirmation and queue',()=>{
  let allowed=true;const h=harness(()=>allowed);
  assert.throws(()=>h.run('restock.confirm',restockRequest,'automation',{beforeCommit:()=>{allowed=false;}}),/denied/);
  assert.deepEqual(h.read(),{entries:[],reviews:[],outbox:[],audit:[]});
});
test('restock confirmation, review, outbox and audit rollback together; replay is independent of tool',()=>{
  const h=harness(()=>true);
  assert.throws(()=>h.run('restock.confirm',restockRequest,'backroom',{failOutbox:true}),/outbox failed/);
  assert.deepEqual(h.read(),{entries:[],reviews:[],outbox:[],audit:[]});
  assert.equal(h.run('restock.confirm',restockRequest,'backroom').replayed,false);
  assert.equal(h.run('restock.confirm',restockRequest,'direct-api').replayed,true);
  assert.throws(()=>h.run('restock.confirm',{...restockRequest,batchId:'B2'},'import'),/conflict/);
  const s=h.read();assert.equal(s.entries.length,1);assert.equal(s.reviews.length,1);assert.equal(s.outbox.length,1);assert.equal(s.audit.length,1);
  assert.equal(s.reviews[0].reviewFlag,'possible_shortage');assert.equal(s.reviews[0].quantityVariance,null);
  assert.equal(s.entries[0].plan.records.confirmation.totalInventoryDelta,0);
});
test('count scan and reason revision replay/conflict remain separate',()=>{
  const h=harness(()=>true), next={...reason,revision:2};
  for(const [op,req,changed] of [['count.observe',countRequest,{...countRequest,countedQuantity:'4'}],['reason.revise',next,{...next,label:'Changed'}]]) {
    assert.equal(h.run(op,req,'inventory').replayed,false);
    assert.equal(h.run(op,req,'indirect').replayed,true);
    assert.throws(()=>h.run(op,changed,'automation'),/conflict/);
  }
  assert.equal(h.read().entries.length,2);
});
test('revoked grant cannot replay a previously successful confirmation',()=>{
  let allowed=true;const h=harness(()=>allowed);
  h.run('restock.confirm',restockRequest,'backroom');allowed=false;
  assert.throws(()=>h.run('restock.confirm',restockRequest,'automation'),/denied/);
  assert.equal(h.read().entries.length,1);
});
test('count or restock grant cannot be repurposed for cost modification, stock adjustment or reason configuration',()=>{
  const h=harness(c=>['count.observe','restock.confirm'].includes(c.operation));
  for(const operation of ['product.cost.modify','stock.adjust','reason.revise'])assert.throws(()=>h.run(operation,{...reason,revision:2},'indirect'),/denied/);
  assert.equal(h.read().entries.length,0);
});
