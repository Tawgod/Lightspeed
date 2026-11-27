import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Evaluate only the exact pure guard/planner block, without loading DB or provider modules.
const source=readFileSync(new URL('../special-orders.js',import.meta.url),'utf8');
const start=source.indexOf('const VALID_STATUSES =');
const end=source.indexOf('let pool = null;',start);
assert.ok(start>=0 && end>start);
const block=source.slice(start,end).replace(/^export function /gm,'function ');
const {orderStatusTransition:status,preorderPickupTransition:pickup,verifiedReceivedQuantity:quantity,planPreorderAllocation:plan}=vm.runInNewContext(block+'\n({orderStatusTransition,preorderPickupTransition,verifiedReceivedQuantity,planPreorderAllocation})');
const rows=[{id:'1',requested_quantity:5,already_allocated:2},{id:'2',requested_quantity:4,already_allocated:0}];
const amounts=result=>Array.from(result.need,r=>r.give);

test('partial allocations use only outstanding quantity',()=>{
  const p=plan(rows,4,'QUEUE');
  assert.deepEqual(amounts(p),[3,1]);
  assert.equal(p.remaining,0);
  assert.equal(rows[0].already_allocated,2);
});
test('fair share respects remaining quantities and capacity',()=>{
  assert.deepEqual(amounts(plan(rows,5,'FAIR_SHARE')),[3,2]);
});
test('manual rejects duplicates, unknown requests and excessive quantities',()=>{
  for(const m of [[{request_id:'1',quantity:4}],[{request_id:'1',quantity:1},{request_id:'1',quantity:1}],[{request_id:'9',quantity:1}],[{request_id:'2',quantity:5}],[{request_id:'1',quantity:1.5}]]) assert.throws(()=>plan(rows,4,'MANUAL',m));
  assert.deepEqual(amounts(plan(rows,2,'MANUAL',[{request_id:'1',quantity:2}])),[2,0]);
});
test('zero capacity, invalid quantities and methods',()=>{
  assert.deepEqual(amounts(plan(rows,0,'QUEUE')),[0,0]);
  assert.throws(()=>plan(rows,-1,'QUEUE'));
  assert.throws(()=>plan(rows,1,'BAD'));
  assert.throws(()=>plan([{requested_quantity:1,already_allocated:2}],1,'QUEUE'));
});
test('terminal orders cannot be resurrected; repeated statuses are noops',()=>{
  for(const from of ['CANCELLED','COMPLETED']) {
    for(const to of ['RECEIVED','ORDERED','OOS','HELD']) assert.equal(status(from,to),'deny');
    assert.equal(status(from,from),'noop');
  }
  assert.equal(status('ORDERED','RECEIVED'),'allow');
  assert.equal(status('OOS','COMPLETED'),'deny');
  assert.equal(status('RECEIVED','CANCELLED'),'deny');
  assert.equal(status('UNKNOWN','ORDERED'),'deny');
});
test('pickup replay is a noop and invalid transitions deny',()=>{
  assert.equal(pickup('ALLOCATED','READY'),'allow');
  assert.equal(pickup('READY','READY'),'noop');
  assert.equal(pickup('READY','PICKED_UP'),'allow');
  assert.equal(pickup('PICKED_UP','PICKED_UP'),'noop');
  assert.equal(pickup('RELEASED','NO_PICKUP'),'noop');
  assert.equal(pickup('PICKED_UP','NO_PICKUP'),'deny');
  assert.equal(pickup('ALLOCATED','PICKED_UP'),'deny');
  assert.equal(pickup('RELEASED','READY'),'deny');
});
test('zero receipt differs from unavailable, malformed and fractional evidence',()=>{
  assert.equal(quantity({received_quantity:0}),0);
  assert.equal(quantity({quantity_received:'12'}),12);
  for(const x of [undefined,null,'',true,-1,1.2,'1.2','-1',' 2',Infinity,Number.MAX_SAFE_INTEGER+1]) assert.equal(quantity({received_quantity:x}),null);
});
