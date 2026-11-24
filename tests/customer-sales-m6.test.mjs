import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSaleWorkflow,createSaleWorkflowRead} from '../services/lightspeed/saleWorkflowEvidence.js';
import {createLightspeedSalesRead} from '../services/lightspeed/sales.js';
import {createLightspeedFulfillmentsRead} from '../services/lightspeed/fulfillments.js';
import {createCoreReadExecutor} from '../services/lightspeed/coreReadContract.js';
const sale={id:'001',customer_id:'C1',state:'pending',line_items:[{id:'L1',product_id:'P1',quantity:'2'}],payments:[{id:'PAY1',amount:'10.00',card:'private'}]};
const fulfillment={id:'F1',sale_id:'001',line_items:[{sale_line_item_id:'L1',product_id:'P1',picked_quantity:'1',packed_quantity:'1',fulfilled_quantity:'0'}]};
const project=(extra={})=>projectSaleWorkflow({saleId:'001',sale,fulfillments:[fulfillment],...extra});
test('financial payments do not establish deposits or customer pickup',()=>{
 const out=project();
 assert.equal(out.paymentEvidence[0].amount,'10.00');
 assert.deepEqual(out.depositEvidence,[]);
 assert.equal(out.depositBalance,null);
 assert.equal(out.fulfillmentEvidence[0].lines[0].packed,'1');
 assert.equal(out.customerPickupQuantity,null);
 assert.equal(out.executionAuthorized,false);
 assert.equal(out.coverage.complete,false);
 assert.ok(!JSON.stringify(out).includes('private'));
});
test('explicit deposit and work-order evidence stays separate from payment and stock',()=>{
 const out=project({depositEvents:[{saleId:'001',eventId:'D1',kind:'deposit-recorded',amount:'10.00',currency:'USD'}],workOrders:[{saleId:'001',workOrderId:'W1',state:'open'}]});
 assert.equal(out.depositEvidence[0].eventId,'D1');
 assert.equal(out.workOrderEvidence[0].workOrderId,'W1');
 assert.equal(out.depositBalance,null);
 assert.equal(out.executionAuthorized,false);
});
test('missing collections remain unknown, explicit empty differs',()=>{
 const out=project({sale:{id:'001'},fulfillments:[]});
 assert.equal(out.lineItems,null);assert.equal(out.paymentEvidence,null);
 assert.equal(out.coverage.payments,'unknown');
 assert.deepEqual(project({sale:{id:'001',payments:[]}}).paymentEvidence,[]);
});
test('orphaned line evidence is flagged without stock effects',()=>{
 const out=project({fulfillments:[{...fulfillment,line_items:[{sale_line_item_id:'L2',product_id:'P1',packed_quantity:'1'}]}]});
 assert.equal(out.fulfillmentEvidence[0].lines[0].association,'orphaned');
 assert.equal(out.fulfillmentEvidence[0].lines[0].customerPickup,null);
});
test('conflicts, malformed quantities and repeated IDs reject',()=>{
 const bad=[
  {sale:{...sale,customer:{id:'C2'}}},
  {sale:{...sale,payments:[{id:'PAY1',amount:0}]}},
  {sale:{...sale,line_items:[sale.line_items[0],sale.line_items[0]]}},
  {sale:{...sale,register_sale_payments:[]}},
  {fulfillments:[{...fulfillment,sale:{id:'002'}}]},
  {fulfillments:[{...fulfillment,line_items:[{sale_line_item_id:'L1',product_id:'P2'}]}]},
  {fulfillments:[fulfillment,fulfillment]},
  {depositEvents:[{saleId:'002',eventId:'D1',kind:'deposit-recorded',amount:'1',currency:'USD'}]}
 ];
 for(const extra of bad)assert.throws(()=>project(extra),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
test('existing readers use same GET paths and propagate trace through Core',async()=>{
 const calls=[];
 const transport={async request(path,opts){calls.push([path,opts]);return {data:path.includes('/fulfillments?')?[fulfillment]:sale};}};
 const reader=createSaleWorkflowRead({sales:createLightspeedSalesRead({transport}),fulfillments:createLightspeedFulfillmentsRead({transport})});
 const execute=createCoreReadExecutor({environment:'test',authorizeRead:async()=>true});
 const out=await execute({operation:'sales.workflow.read',context:{},read:opts=>reader.get('001',opts)});
 assert.equal(out.status,200);assert.equal(out.body.data.saleId,'001');
 assert.deepEqual(calls.map(x=>x[0]),['/api/2.0/sales/001','/api/2.0/fulfillments?sale_id=001']);
 assert.ok(calls.every(x=>x[1].correlationId===out.body.correlationId));
 assert.deepEqual(Object.keys(reader),['get']);
});
test('synthetic exact grant denial applies equally to direct and indirect entrypoints',async()=>{
 let reads=0;
 const origins=['special-orders','preorders','split-recall','direct-api','import','automation'];
 let active=true;
 const execute=createCoreReadExecutor({environment:'test',authorizeRead:async({operation})=>active&&operation==='sales.workflow.read'});
 for(const origin of origins){
  const run=operation=>execute({operation,context:{origin},read:async()=>{reads++;return project();}});
  assert.equal((await run('sales.deposit.collect')).status,403);
  assert.equal((await run('sales.workflow.read')).status,200);
 }
 assert.equal(reads,origins.length);
 active=false;
 assert.equal((await execute({operation:'sales.workflow.read',context:{origin:'automation'},read:async()=>{reads++;return project();}})).status,403);
 assert.equal(reads,origins.length);
});
