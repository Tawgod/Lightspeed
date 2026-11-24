import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfflineCustomerSales} from '../services/lightspeed/offlineCustomerSales.js';
import {createLightspeedCustomersRead} from '../services/lightspeed/customers.js';
const actor={actorId:'staff-01',tenantId:'tenant-01'};
const fixture=(decision=()=>true,change={})=>{
 const calls=[],checks=[];
 const track=(key,value)=>async(id,opts)=>{calls.push({key,id,opts});return structuredClone(value);};
 const stamp='2026-11-24T00:00:00Z';
 const sale={id:'001',customer_id:'C1',line_items:[{id:'L1',product_id:'P1',quantity:'2'}],payments:[{id:'PAY',amount:'10.00'}]};
 const pickup={eventId:'PK1',saleId:'001',customerId:'C1',kind:'pickup-confirmed',lineId:'L1',productId:'P1',quantity:'1'};
 const options={environment:'test',authorize:async q=>{checks.push(q);return decision(q);},
 customers:{get:track('customer',{data:{id:'C1',email:'private'}}),searchFirstPage:track('first',{rows:[{id:'002',first_name:'B',email:'private'},{id:'001',first_name:'A'}]}),search:track('all',[{id:'001'}])},
 sales:{get:track('sale',{data:sale})},fulfillments:{forSale:track('fulfillments',[{id:'F1',saleId:'001',raw:{id:'F1',sale_id:'001',line_items:[{sale_line_item_id:'L1',product_id:'P1',fulfilled_quantity:'2'}]}}])},
 storeCredit:{get:track('credit',{data:{customer_id:'C1',amount:'5.00',currency:'USD'}})},
 readLinks:track('links',[{customerId:'C1',provider:'discord',externalId:'secret',status:'verified',observedAt:stamp}]),
 readConsents:track('consents',[{customerId:'C1',channel:'email',purpose:'order-update',status:'opt-out',evidenceId:'E1',observedAt:stamp}]),
 readDeposits:track('deposits',[{saleId:'001',eventId:'D1',kind:'deposit-recorded',amount:'5',currency:'USD'}]),
 readOrders:track('orders',[{saleId:'001',workOrderId:'W1',state:'open'}]),
 readReversals:track('reversals',[{eventId:'R1',kind:'merchandise-return',saleId:'001',customerId:'C1',lineId:'L1',productId:'P1',quantity:'1'},{eventId:'V1',kind:'sale-void',saleId:'001',customerId:'C1'}]),
 readPickups:track('pickups',[pickup]),...change};
 return {api:createOfflineCustomerSales(options),calls,checks};
};
test('offline only and explicit actor',async()=>{
 assert.throws(()=>createOfflineCustomerSales({environment:'production',authorize:()=>true}));
 const f=fixture();await assert.rejects(f.api.workflow({},'001'),{code:'CORE_FORBIDDEN'});assert.equal(f.calls.length,0);
});
test('each composite grant independently required before first raw sale IO',async()=>{
 for(const op of ['sales.read','sales.payments.read','sales.deposit.read','sales.work-orders.read','fulfillments.read','sales.reversals.read','sales.returns.read','store-credit.read']){
  const f=fixture(q=>q.operation!==op);await assert.rejects(f.api.workflow(actor,'001'),{code:'CORE_FORBIDDEN'});assert.equal(f.calls.length,0);
 }
});
test('customer scope denial blocks balance IO and all output',async()=>{
 const f=fixture(q=>!(q.operation==='store-credit.read'&&q.resource.kind==='customer'));
 await assert.rejects(f.api.workflow(actor,'001'),{code:'CORE_FORBIDDEN'});assert.ok(!f.calls.some(c=>c.key==='credit'));
});
test('revocation, truthy nonboolean and verifier outage fail closed',async()=>{
 for(const decision of [q=>q.phase==='io',()=>({allowed:true}),()=>{throw Error('private');}]){
  const f=fixture(decision);await assert.rejects(f.api.workflow(actor,'001'),{code:'CORE_FORBIDDEN'});
 }
});
test('integrated workflow preserves event separation, trace, actor and exact IDs',async()=>{
 const f=fixture();const out=await f.api.workflow(actor,'001');
 assert.equal(out.data.workflow.saleId,'001');assert.equal(out.data.workflow.paymentEvidence[0].amount,'10.00');
 assert.equal(out.data.workflow.depositEvidence[0].amount,'5');assert.equal(out.data.workflow.customerPickupQuantity,null);
 assert.equal(out.data.pickupEvidence[0].quantity,'1');assert.equal(out.data.netPickup,null);
 assert.equal(out.data.reversal.physical[0].stockEffect,null);assert.equal(out.data.reversal.financial[0].kind,'sale-void');
 assert.equal(out.data.reversal.balance.amount,'5.00');assert.equal(out.data.executionAuthorized,false);
 assert.ok(f.calls.every(c=>c.opts.correlationId===out.correlationId));assert.ok(f.checks.every(c=>c.actor.actorId===actor.actorId&&c.actor.tenantId===actor.tenantId&&c.correlationId===out.correlationId));
});
test('identity consent purpose isolated, no external IDs or send authority',async()=>{
 const f=fixture();const out=await f.api.identity(actor,'C1','order-update');
 assert.equal(out.data.consents[0].status,'opt-out');assert.equal(out.data.canSend,false);assert.ok(!JSON.stringify(out).includes('secret'));
 await assert.rejects(f.api.identity(actor,'C1','marketing'),{code:'LIGHTSPEED_INCOMPLETE_READ'});
 const g=fixture(q=>q.operation!=='customers.consent.read');await assert.rejects(g.api.identity(actor,'C1','order-update'),{code:'CORE_FORBIDDEN'});assert.ok(!g.calls.some(c=>c.key==='consents'));
});
test('actual shared search first-page URL, ordering and minimal projection',async()=>{
 const paths=[];const customers=createLightspeedCustomersRead({transport:{request:async(path)=>{paths.push(path);return {data:[{id:'002',first_name:'B',email:'private'},{id:'001',first_name:'A'}]};}}});
 const f=fixture(()=>true,{customers});const out=await f.api.search(actor,'A B');
 assert.deepEqual(out.data.items.map(x=>x.customerId),['002','001']);assert.equal(paths.length,1);assert.ok(paths[0].includes('page_size=20'));assert.ok(!JSON.stringify(out).includes('private'));assert.equal(out.data.complete,false);
 const g=fixture(q=>!(q.resource.kind==='customer'&&q.resource.id==='002'));await assert.rejects(g.api.search(actor,'A'),{code:'CORE_FORBIDDEN'});
});
test('pickup reversal must link original event; missing pickup not inferred',async()=>{
 const f=fixture(()=>true,{readPickups:async()=>[{eventId:'PK2',saleId:'001',customerId:'C1',kind:'pickup-reversed',lineId:'L1',productId:'P1',quantity:'1',originalEventId:'missing'}]});
 await assert.rejects(f.api.workflow(actor,'001'),{code:'LIGHTSPEED_INCOMPLETE_READ'});
 const g=fixture(()=>true,{readPickups:async()=>[]});const out=await g.api.workflow(actor,'001');assert.deepEqual(out.data.pickupEvidence,[]);assert.equal(out.data.netPickup,null);
});
