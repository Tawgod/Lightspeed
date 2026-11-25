import test from 'node:test';
import assert from 'node:assert/strict';
import {createScopedCustomerFixture,assessCumulativeEvidence} from '../services/lightspeed/customerSalesM9.js';
const actor={actorId:'A1',tenantId:'T1'}, scope={outlet:'O1',purpose:'order-service'};
const setup=(allow=()=>true,source)=>{const calls=[],checks=[];return {calls,checks,api:createScopedCustomerFixture({environment:'test',authorize:async q=>{checks.push(q);return allow(q);},readProjected:async q=>{calls.push(q);return source?source(q):[{id:'002',first_name:'B'},{id:'001',first_name:'A'}].map(row=>Object.fromEntries(Object.entries(row).filter(([k])=>q.fields.includes(k))));}})};};
test('ordinary minimal customer search needs no unrelated contact notes or financial grants',async()=>{
 const f=setup(q=>q.operation==='customers.search');const r=await f.api.search(actor,'Jane',scope);
 assert.deepEqual(r.rows.map(x=>x.id),['002','001']);assert.equal(r.complete,false);
 assert.equal(f.calls[0].outlet,'O1');assert.ok(f.checks.every(q=>q.correlationId===r.correlationId&&q.actor.tenantId==='T1'));
});
test('contact matching needs contact access even without contact disclosure',async()=>{
 const f=setup(q=>q.operation==='customers.search');await assert.rejects(f.api.search(actor,'a@example.test',scope),{code:'CORE_FORBIDDEN'});assert.equal(f.calls.length,0);
 await assert.rejects(f.api.search(actor,'319-555-0101',scope),{code:'CORE_FORBIDDEN'});assert.equal(f.calls.length,0);
});
test('authorized ordinary contact and note fields can be disclosed, restrictions deny before IO',async()=>{
 const opts={...scope,requestedFields:['id','email','notes']};
 const f=setup(()=>true,()=>[{id:'001',email:'a@example.test',notes:'fixture note'}]);assert.equal((await f.api.search(actor,'Jane',opts)).rows[0].notes,'fixture note');
 const g=setup(q=>q.operation!=='customers.notes.read');await assert.rejects(g.api.search(actor,'Jane',opts),{code:'CORE_FORBIDDEN'});assert.equal(g.calls.length,0);
});
test('wrong customer scope, revoked projection, verifier failure and unsupported fields fail closed',async()=>{
 for(const allow of [q=>q.resource.id!=='002',q=>q.phase==='io',()=>({allow:true}),()=>{throw Error('private');}]){
  const f=setup(allow);await assert.rejects(f.api.search(actor,'Jane',scope),{code:'CORE_FORBIDDEN'});
 }
 const f=setup();await assert.rejects(f.api.search(actor,'Jane',{...scope,requestedFields:['id','card_number']}),TypeError);assert.equal(f.calls.length,0);
});
test('projected source contract rejects extra fields, duplicate IDs, malformed results and excess first page',async()=>{
 for(const rows of [[{id:'001',notes:'private'}],[{id:'001'},{id:'001'}],{},Array.from({length:21},(_,i)=>({id:String(i)}))]){
  const f=setup(()=>true,()=>rows);await assert.rejects(f.api.search(actor,'Jane',scope),{code:'LIGHTSPEED_INCOMPLETE_READ'});
 }
 const f=setup();assert.deepEqual((await f.api.search(actor,' ',scope)).rows,[]);assert.equal(f.calls.length,0);
});
const common={saleId:'S1',customerId:'C1'},line={...common,id:'L1',productId:'P1',quantity:'3.50'};
const base={...common,revision:'R1',lines:[line,{...line,id:'L2',productId:'P2',quantity:'2'}],payments:[{...common,id:'PAY',currency:'USD',amount:'10.10',sourceConfirmed:true}],deposits:[{...common,id:'DEP',currency:'USD',amount:'5.00',sourceConfirmed:true}],credits:[{...common,id:'CR',currency:'USD',amount:'4.25',sourceConfirmed:true}],coverage:{...common,revision:'R1',complete:true},events:[]};
const e=(sequence,kind,targetId,extra)=>({...common,sequence,eventId:'E'+sequence,kind,targetId,...extra});
const pickup=e(1,'pickup','L1',{productId:'P1',quantity:'1.25'});
const reversal=e(2,'pickup-reversal','L1',{productId:'P1',quantity:'0.25',originalEventId:'E1'});
const money=(n,kind,targetId,amount)=>e(n,kind,targetId,{currency:'USD',amount});
test('exact cumulative partial pickup and independent financial limits are evidence only',()=>{
 const r=assessCumulativeEvidence({...base,events:[pickup,reversal,e(3,'return','L1',{productId:'P1',quantity:'0.5'}),money(4,'payment-reversal','PAY','3.10'),money(5,'deposit-reversal','DEP','2'),money(6,'credit-reversal','CR','1.25')]});
 assert.equal(r.items[0].observedPickup,'1.000000');assert.equal(r.items[0].remainingPickup,'2.500000');assert.equal(r.items[0].observedReturn,'0.500000');
 assert.equal(r.items[2].remainingReversal,'7.000000');assert.equal(r.items[3].remainingReversal,'3.000000');assert.equal(r.items[4].remainingReversal,'3.000000');assert.equal(r.executionAuthorized,false);assert.equal(r.stockEffect,null);assert.equal(r.eligibility,'requires-review');
});
test('missing or stale completeness never establishes remaining eligibility',()=>{
 for(const coverage of [undefined,{...base.coverage,revision:'old'},{...base.coverage,customerId:'C2'}]){
  const r=assessCumulativeEvidence({...base,coverage,events:[pickup]});assert.equal(r.items[0].remainingPickup,null);assert.equal(r.items[2].remainingReversal,null);
 }
});
test('cumulative overages and original pickup reversal overages reject',()=>{
 for(const events of [[pickup,e(2,'pickup','L1',{productId:'P1',quantity:'3'})],[pickup,reversal,e(3,'pickup-reversal','L1',{productId:'P1',quantity:'1.01',originalEventId:'E1'})],[money(1,'payment-reversal','PAY','8'),money(2,'payment-reversal','PAY','2.11')],[money(1,'deposit-reversal','DEP','6')],[money(1,'credit-reversal','CR','5')]]){
  assert.throws(()=>assessCumulativeEvidence({...base,events}),{code:'LIGHTSPEED_INCOMPLETE_READ'});
 }
});
test('duplicate, mismatched target, wrong currency, chronology and unconfirmed financial source reject',()=>{
 for(const events of [[pickup,pickup],[{...pickup,customerId:'C2'}],[{...pickup,productId:'P2'}],[{...money(1,'payment-reversal','PAY','1'),currency:'EUR'}],[reversal,pickup],[money(1,'credit-reversal','PAY','1')]]){
  assert.throws(()=>assessCumulativeEvidence({...base,events}),{code:'LIGHTSPEED_INCOMPLETE_READ'});
 }
 assert.throws(()=>assessCumulativeEvidence({...base,payments:[{...base.payments[0],sourceConfirmed:false}]}),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
