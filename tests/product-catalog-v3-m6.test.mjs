import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCatalogOperationScenario} from '../services/lightspeed/productCatalogOperationFixtures.js';
const target={productId:'000P',variantId:'000V'};
const scenario=(over={})=>({tool:'ProductManager',channel:'direct',effect:'create',phase:'execute',changes:[{target,fields:['sku']}],...over});
const run=(s,authorize)=>inspectCatalogOperationScenario({scenario:s,authorize,context:{synthetic:true}});
test('canonical create denial across tools and every entrypoint',async()=>{
 for(const tool of ['ProductManager','Scanner','SpecialOrders','Purchasing','Consignment','Preorders','Repairs','RMSImport','Automation'])
 for(const channel of ['direct','api','bulk','import','indirect','automation']){
  const r=await run(scenario({tool,channel}),a=>a.operation!=='catalog.product.create');
  assert.equal(r.state,'denied');assert.equal(r.executable,false);
 }
});
test('canonical update denial across direct and indirect paths',async()=>{
 for(const tool of ['ProductManager','Scanner','SpecialOrders','Purchasing','Automation'])
 for(const channel of ['api','bulk','import','indirect','automation'])
 assert.equal((await run(scenario({tool,channel,effect:'update'}),a=>a.operation!=='catalog.product.update')).state,'denied');
});
test('cost modification is independent of read, creation and update',async()=>{
 for(const effect of ['create','update']){
 const r=await run(scenario({effect,changes:[{target,fields:['cost','sku']}]}),a=>a.operation!=='catalog.product.cost.modify');
 assert.equal(r.state,'denied');
 }
});
test('approval and execution are distinct checks',async()=>{
 for(const phase of ['approve','execute']){
 const r=await run(scenario({phase}),a=>a.operation!=='catalog.product.create.'+phase);
 assert.equal(r.state,'denied');
 }
});
test('revoked or expired synthetic grant rechecked at execution',async()=>{
 let active=true;const authorize=()=>active;
 assert.equal((await run(scenario({phase:'propose'}),authorize)).state,'fixture_checks_passed');
 active=false;
 assert.equal((await run(scenario({channel:'automation'}),authorize)).state,'denied');
});
test('bulk checks all exact resources and fields, no partial executable result',async()=>{
 const seen=[];const s=scenario({channel:'bulk',effect:'update',changes:[{target,fields:['name']},{target:{productId:'000Q',variantId:null},fields:['cost']}]});
 const r=await run(s,a=>{seen.push(a);return a.resource.productId!=='000Q';});
 assert.equal(r.state,'denied');assert.equal(r.executable,false);assert.equal(seen[0].resource.variantId,'000V');
 assert.ok(seen.every(a=>a.environment==='test'&&a.correlationId===seen[0].correlationId));
});
test('unknown effects, tools, fields and malformed targets deny without adapter call',async()=>{
 for(const s of [scenario({tool:'unknown'}),scenario({effect:'read'}),scenario({changes:[{target,fields:['hiddenCost']}]}),scenario({changes:[{target:{productId:7,variantId:null},fields:['sku']}]})]){
 assert.equal((await run(s,()=>{throw Error('must not call');})).state,'denied');
 }
});
test('missing, truthy or unavailable decisions deny; success never executes',async()=>{
 for(const a of [undefined,()=>({allowed:true}),()=>null,()=>{throw Error('outage');}])assert.equal((await run(scenario(),a)).state,'denied');
 const r=await run(scenario(),()=>true);assert.equal(r.state,'fixture_checks_passed');assert.equal(r.executable,false);
});
