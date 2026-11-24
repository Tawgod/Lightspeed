import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreReadExecutor } from '../services/lightspeed/coreReadContract.js';
import { createLightspeedTransport } from '../services/lightspeed/client.js';
import { createLightspeedCustomersRead } from '../services/lightspeed/customers.js';
import { createCustomerSalesEvidence } from '../services/lightspeed/customerSalesEvidence.js';
import { createLightspeedSalesRead } from '../services/lightspeed/sales.js';
import { createLightspeedProductsRead } from '../services/lightspeed/products.js';
import { createLightspeedInventoryRead } from '../services/lightspeed/inventory.js';
import { observeOutletInventory } from '../services/lightspeed/inventoryEvidence.js';
import { createLightspeedPurchaseOrdersRead } from '../services/lightspeed/purchaseOrders.js';
import { createPurchasingRead } from '../services/lightspeed/purchaseOrderProjection.js';

// Offline composition only. The admission double is NOT an identity verifier,
// grant issuer, or proposed Security implementation. All data are synthetic.
const fixture = (operation, responses, admission = async a => a.operation === operation && a.mode === 'read' && a.environment === 'test') => {
  const calls = [];
  const events = [];
  const transport = createLightspeedTransport({domain:'fixture',token:'synthetic-only',readRetries:0,fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname+new URL(url).search;
    calls.push({path,method:options.method,trace:options.headers['X-Request-ID']});
    assert.equal(options.method,'GET');
    assert.ok(Object.hasOwn(responses,path),'Unexpected synthetic path: '+path);
    return new Response(JSON.stringify(responses[path]));
  }});
  const run = createCoreReadExecutor({environment:'test',authorizeRead:async a=>{events.push(a);return admission(a);}});
  // Per-operation closure forwards trace to existing readers without changing
  // their interfaces. Never expose this factory to an untrusted caller.
  const execute = read => run({operation,context:Object.freeze({fixture:true}),read:({correlationId})=>
    read(Object.freeze({request:(path,options={})=>transport.request(path,{...options,correlationId})}))});
  return {execute,calls,events};
};
function check(f,r) {
  assert.equal(r.status,200);
  assert.equal(r.body.version,'core.v1');
  assert.equal(r.body.readOnly,true);
  assert.equal(f.events.length,1);
  assert.ok(f.calls.length);
  assert.ok(f.calls.every(c=>c.method==='GET'&&c.trace===r.body.correlationId));
  assert.equal(f.events[0].correlationId,r.body.correlationId);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_FIXTURE'));
}
const evidence = transport => createCustomerSalesEvidence({
  customers:createLightspeedCustomersRead({transport}),sales:createLightspeedSalesRead({transport}),
  fulfillments:{forSale:async()=>[]},storeCredit:{get:async()=>{throw Error('not used');}}
});
test('customer search composes exact admission, multi-page trace and minimal contact evidence',async()=>{
  const path='/api/2026-04/search?type=customers&page_size=20&email=fixture%40example.invalid';
  const f=fixture('customers.search',{[path]:{data:[{id:'C01',email:'fixture@example.invalid',phone:'PRIVATE_FIXTURE'}],links:{next:'?type=customers&page_size=20&email=fixture%40example.invalid&offset=1'}},[path+'&offset=1']:{data:[{id:'C02',email:'other@example.invalid'}],links:{next:null}}});
  const r=await f.execute(t=>evidence(t).matchContact('email','fixture@example.invalid'));
  check(f,r);assert.equal(f.calls.length,2);assert.equal(r.body.data.matches[0].customerId,'C01');
  assert.equal(r.body.data.requiresReview,true);
  assert.ok(!JSON.stringify(r).includes('fixture@example.invalid'));
});
test('sales evidence preserves single-page coverage rather than inventing completeness',async()=>{
  const f=fixture('sales.read',{'/api/2.0/search?type=sales&customer_id=C01&page_size=1000':{data:[{id:'S01',customer_id:'C01',state:'OPEN',invoice_number:'0001',notes:'PRIVATE_FIXTURE'}]}});
  const r=await f.execute(t=>evidence(t).salesPage('customer','C01'));
  check(f,r);assert.equal(r.body.data.complete,false);assert.equal(r.body.data.items[0].invoiceNumber,'0001');
});
test('catalog exact read traces both vendor lookups and fixture display projection excludes cost',async()=>{
  const product={id:'P01',sku:'000123',name:'Fixture item',cost:'PRIVATE_FIXTURE'};
  const f=fixture('products.exact',{'/api/2026-07/products?sku=000123&page_size=1000':{data:[product]},'/api/2026-07/search?type=products&sku=000123&page_size=20':{data:[product]}});
  const r=await f.execute(async t=>{const p=await createLightspeedProductsRead({transport:t}).exact('000123');return p===null?null:{id:p.id,sku:p.sku,name:p.name};});
  check(f,r);assert.equal(f.calls.length,2);assert.equal(r.body.data.sku,'000123');
});
test('inventory evidence remains unverified and excludes raw cost',async()=>{
  const f=fixture('inventory.read',{'/api/2026-04/inventory/P01':{data:{product_id:'P01',outlets:[{id:'O01',current_inventory_level:'3',cost:'PRIVATE_FIXTURE'}]}}});
  const r=await f.execute(t=>observeOutletInventory({reader:createLightspeedInventoryRead({transport:t}),productId:'P01',outletId:'O01',clock:()=> '2026-11-24T12:00:00.000Z'}));
  check(f,r);assert.equal(r.body.data.onHand,'3');assert.equal(r.body.data.evidenceStatus,'unverified');assert.equal(r.body.data.available,null);
});
test('purchasing projection traces header and lines without raw fields or physical receipt inference',async()=>{
  const f=fixture('purchase-orders.read',{'/api/2026-04/purchase_orders?page_size=1000':{data:[{id:'PO01',supplier_id:'SUP01',status:'RECEIVED',notes:'PRIVATE_FIXTURE'}]},'/api/2026-04/purchase_orders/PO01/line_items?page_size=1000':{data:[{id:'L01',product_id:'P01',quantity_ordered:'2',supplier_sku:'0007',cost:'PRIVATE_FIXTURE'}]}});
  const r=await f.execute(t=>createPurchasingRead({purchaseOrders:createLightspeedPurchaseOrdersRead({transport:t})}).get('PO01'));
  check(f,r);assert.equal(f.calls.length,2);assert.equal(r.body.data.lines[0].supplierSku,'0007');assert.equal(r.body.data.receiving.state,'UNKNOWN');
});
test('all four domain grants deny before any transport or projection',async()=>{
  for(const operation of ['customers.search','products.exact','inventory.read','purchase-orders.read']){
    for(const admission of [async()=>false,async()=>({allowed:true}),async()=>{throw Error('PRIVATE_FIXTURE');}]){
      const f=fixture(operation,{},admission);let invoked=0;
      const r=await f.execute(()=>{invoked++;return {};});
      assert.equal(r.status,403);assert.equal(invoked,0);assert.equal(f.calls.length,0);
      assert.ok(!JSON.stringify(r).includes('PRIVATE_FIXTURE'));
    }
  }
});
test('malformed customer evidence produces safe incomplete-read envelope',async()=>{
  const f=fixture('customers.search',{'/api/2026-04/search?type=customers&page_size=20&email=fixture%40example.invalid':{unexpected:'PRIVATE_FIXTURE'}});
  const r=await f.execute(t=>evidence(t).matchContact('email','fixture@example.invalid'));
  assert.equal(r.status,502);assert.equal(r.body.error.code,'LIGHTSPEED_INCOMPLETE_READ');assert.ok(!JSON.stringify(r).includes('PRIVATE_FIXTURE'));
});
test('separate concurrent requests do not share correlation IDs',async()=>{
  const path='/api/2.0/products/P01';
  const f=fixture('products.exact',{[path]:{data:{id:'P01'}}});
  const read=t=>createLightspeedProductsRead({transport:t}).get('P01');
  const [a,b]=await Promise.all([f.execute(read),f.execute(read)]);
  assert.notEqual(a.body.correlationId,b.body.correlationId);
  assert.deepEqual(new Set(f.calls.map(c=>c.trace)),new Set([a.body.correlationId,b.body.correlationId]));
});
