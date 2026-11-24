import test from 'node:test';
import assert from 'node:assert/strict';
import {projectReversalEvidence,createReversalEvidenceRead} from '../services/lightspeed/reversalEvidence.js';
import {projectSaleWorkflow} from '../services/lightspeed/saleWorkflowEvidence.js';
import {createLightspeedStoreCreditRead} from '../services/lightspeed/storeCredit.js';
import {createCoreReadExecutor} from '../services/lightspeed/coreReadContract.js';
const workflow=projectSaleWorkflow({saleId:'001',sale:{id:'001',customer_id:'C1',line_items:[{id:'L1',product_id:'P1',quantity:'2'}],payments:[{id:'P01',amount:'10'}]},fulfillments:[{id:'F1',sale_id:'001',line_items:[{sale_line_item_id:'L1',product_id:'P1',fulfilled_quantity:'1'}]}],depositEvents:[{saleId:'001',eventId:'D1',kind:'deposit-recorded',amount:'5',currency:'USD'}],workOrders:[{saleId:'001',workOrderId:'W1',state:'open'}]});
const event=(eventId,kind,extra={})=>({eventId,kind,saleId:'001',customerId:'C1',...extra});
const issued=event('C01','credit-issued',{amount:'5.00',currency:'USD',paymentId:'P01',depositEventId:'D1'});
const reversed=event('C02','credit-reversal',{amount:'2.00',currency:'USD',originalEventId:'C01'});
const merchandise=event('R1','merchandise-return',{lineId:'L1',productId:'P1',quantity:'1',fulfillmentId:'F1',workOrderId:'W1'});
const project=(events=[],extra={})=>projectReversalEvidence({saleId:'001',workflow,events,...extra});
test('physical and financial evidence separated; no net balance or stock inference',()=>{
 const out=project([merchandise,issued,reversed,event('V1','sale-void')]);
 assert.equal(out.financial.length,3);assert.equal(out.physical.length,1);
 assert.equal(out.physical[0].stockEffect,null);assert.equal(out.stockAdjustment,null);
 assert.equal(out.netRefund,null);assert.equal(out.netCredit,null);assert.equal(out.executionAuthorized,false);assert.equal(out.complete,false);
});
test('credit reversal links exact original event independent of input order',()=>{
 assert.equal(project([reversed,issued]).financial[0].originalEventId,'C01');
 for(const bad of [{originalEventId:'missing'},{currency:'EUR'},{originalEventId:'C02'}]) assert.throws(()=>project([issued,{...reversed,...bad}]),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
test('payment deposit work-order and fulfillment associations must resolve',()=>{
 const payment=event('P2','payment-reversal',{amount:'1',currency:'USD',paymentId:'P01'});
 const deposit=event('D2','deposit-reversal',{amount:'2',currency:'USD',depositEventId:'D1'});
 assert.equal(project([payment,deposit]).financial.length,2);
 for(const bad of [{...payment,paymentId:'bad'},{...deposit,depositEventId:'bad'},{...deposit,currency:'EUR'},{...merchandise,workOrderId:'bad'},{...merchandise,fulfillmentId:'bad'},{...merchandise,productId:'P2'}]) assert.throws(()=>project([bad]),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
test('duplicates cross-customer and ambiguous amounts reject',()=>{
 for(const events of [[issued,issued],[{...issued,customerId:'C2'}],[{...issued,amount:5}],[{...issued,amount:'0.00'}],[{...issued,amount:'-5'}],[{...issued,currency:123}],[{...issued,quantity:'1'}]]) assert.throws(()=>project(events),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
test('snapshot requires explicit ownership and exact amount; no private fields',()=>{
 const out=project([issued],{creditSnapshot:{customer_id:'C1',amount:'0.00',currency:'USD',notes:'private'}});
 assert.deepEqual(out.balance,{amount:'0.00',currency:'USD',association:'source-confirmed'});
 assert.ok(!JSON.stringify(out).includes('private'));
 assert.equal(project([],{creditSnapshot:{amount:'5',currency:'USD'}}).balance,null);
 assert.throws(()=>project([],{creditSnapshot:{customer_id:'C1',customer:{id:'C2'}}}),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
test('Core denial precedes evidence reads; request tracing and safe projection',async()=>{
 const calls=[];
 const storeCredit=createLightspeedStoreCreditRead({transport:{async request(path,opts){calls.push([path,opts]);return {data:{customer_id:'C1',amount:'5',currency:'USD'}};}}});
 const reader=createReversalEvidenceRead({workflow:{async get(id,opts){calls.push(['workflow',opts]);return workflow;}},readEvents:async(id,opts)=>{calls.push(['events',opts]);return [issued];},storeCredit});
 let active=true;
 const execute=createCoreReadExecutor({environment:'test',authorizeRead:async({operation})=>active&&operation==='sales.reversals.read'});
 const run=(operation,origin)=>execute({operation,context:{origin},read:opts=>reader.get('001',opts)});
 for(const origin of ['consignment','special-orders','split-recall','direct-api','import','automation']) assert.equal((await run('store-credit.issue',origin)).status,403);
 assert.equal(calls.length,0);
 const result=await run('sales.reversals.read','consignment');
 assert.equal(result.status,200);assert.equal(calls.length,3);
 assert.equal(calls[2][0],'/api/2026-07/store_credits/C1');
 assert.ok(calls.every(([,opts])=>opts.correlationId===result.body.correlationId));
 active=false;assert.equal((await run('sales.reversals.read','automation')).status,403);assert.equal(calls.length,3);
});
test('unassociated sale skips balance read and cannot carry credit events',async()=>{
 const guest={...workflow,customerId:null};
 const reader=createReversalEvidenceRead({workflow:{get:async()=>guest},readEvents:async()=>[],storeCredit:{get:async()=>{throw Error('must not read');}}});
 assert.equal((await reader.get('001')).balance,null);
 assert.throws(()=>project([{...issued,customerId:null}],{workflow:guest}),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
