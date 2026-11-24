import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalTransactionCandidate } from '../services/lightspeed/localTransactionCandidate.js';
import { createCoreReadExecutor } from '../services/lightspeed/coreReadContract.js';

// Test-only mapping of representative entrypoints, NOT the Security registry.
// Tool identity never replaces the underlying operation.
const entries=['Product Manager','Scanner','Special Orders','Purchasing','direct API','bulk import','automation'];
const command=(tool,operations)=>({scope:'test:shop:products.create',key:'fixture-001',operations,context:{tool},payload:{sku:'0001'},apply:async()=>({id:'P01'})});
function fixture(authorize){
  let opened=0, applied=0;const denied=[];
  const run=createLocalTransactionCandidate({authorize,auditDenied:async e=>denied.push(e),transaction:async work=>{
    opened++;return work({claim:async()=>({state:'claimed'}),appendAudit:async()=>{},complete:async()=>{}});
  }});
  return {run:input=>run({...input,apply:async()=>{applied++;return input.apply();}}),stats:()=>({opened,applied,denied})};
}
test('canonical create denial applies across all representative entrypoints',async()=>{
  for(const tool of entries){
    const f=fixture(async a=>a.operation!=='products.create');
    await assert.rejects(f.run(command(tool,['products.create'])),e=>e.code==='CORE_FORBIDDEN');
    assert.equal(f.stats().opened,0);assert.equal(f.stats().applied,0);assert.equal(f.stats().denied.length,1);
  }
});
test('tool-specific or workflow grant cannot replace canonical create grant',async()=>{
  for(const tool of entries){
    const f=fixture(async a=>a.operation==='workflow.execute');
    await assert.rejects(f.run(command(tool,['workflow.execute','products.create'])),e=>e.code==='CORE_FORBIDDEN');
    assert.equal(f.stats().applied,0);
  }
});
test('composed grants all required, valid grants permit synthetic operation',async()=>{
  for(const tool of entries){
    const f=fixture(async a=>['products.create','workflow.execute'].includes(a.operation));
    const r=await f.run(command(tool,['products.create','workflow.execute']));
    assert.equal(r.replayed,false);assert.equal(f.stats().applied,1);
  }
});
test('missing ambiguous unavailable or expired synthetic grant denies',async()=>{
  for(const authorize of [async()=>undefined,async()=>({allowed:true}),async()=>{throw Error('fixture unavailable');},async()=>false]){
    const f=fixture(authorize);
    await assert.rejects(f.run(command('automation',['products.create'])),e=>e.code==='CORE_FORBIDDEN');
    assert.equal(f.stats().applied,0);
  }
});
test('ordinary active employee product access includes wholesale cost, not cost modification',async()=>{
  // Synthetic Security verdicts represent policy; no local roles or authentication.
  for(const tool of entries){
    const read=createCoreReadExecutor({environment:'test',authorizeRead:async a=>a.operation==='products.read'});
    const result=await read({operation:'products.read',context:{tool},read:async()=>({sku:'0001',wholesaleCost:'12.34'})});
    assert.equal(result.status,200);assert.equal(result.body.data.wholesaleCost,'12.34');
    const f=fixture(async a=>a.operation==='products.update');
    await assert.rejects(f.run(command(tool,['products.update','products.cost.modify'])),e=>e.code==='CORE_FORBIDDEN');
    assert.equal(f.stats().applied,0);
  }
});
test('anonymous or inactive synthetic identity cannot view wholesale cost',async()=>{
  for(const decision of [false,undefined]){
    const run=createCoreReadExecutor({environment:'test',authorizeRead:async()=>decision});
    let called=0;const r=await run({operation:'products.read',read:async()=>{called++;return {wholesaleCost:'12.34'};}});
    assert.equal(r.status,403);assert.equal(called,0);assert.ok(!JSON.stringify(r).includes('12.34'));
  }
});
test('production scope cannot invoke local transaction candidate',async()=>{
  const f=fixture(async()=>true);
  await assert.rejects(f.run({...command('automation',['products.create']),scope:'production:shop:products.create'}),TypeError);
  assert.equal(f.stats().opened,0);
});
