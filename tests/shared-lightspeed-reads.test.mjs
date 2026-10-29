import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readLightspeedCollection, LightspeedIncompleteReadError } from '../services/lightspeed/readCollection.js';
import { createLightspeedProductsRead, findExactLightspeedProducts } from '../services/lightspeed/products.js';
import { createLightspeedPurchaseOrdersRead, normalizeLightspeedPurchaseOrder } from '../services/lightspeed/purchaseOrders.js';
import { createLightspeedSalesRead } from '../services/lightspeed/sales.js';
import { createLightspeedInventoryRead } from '../services/lightspeed/inventory.js';
import { createLightspeedFulfillmentsRead } from '../services/lightspeed/fulfillments.js';
import { createLightspeedStoreCreditRead } from '../services/lightspeed/storeCredit.js';
import { createSharedLightspeedReadRouter } from '../routes/sharedLightspeedRead.js';
import { createStaffLightspeedPolicy } from '../services/lightspeed/staffAdapter.js';

const fake = responses => ({
  paths: [],
  async request(path) {
    this.paths.push(path);
    const response = responses[path];
    if (response instanceof Error) throw response;
    if (response === undefined) throw Error('Unexpected vendor path: ' + path);
    return response;
  }
});
test('list pagination uses explicit local continuation and refuses silent truncation', async () => {
  const transport = fake({
    '/api/2026-04/purchase_orders?page_size=2': {
      data: [{id:'PO1'}, {id:'PO2'}],
      links: {next:'?page_size=2&page=2'}
    },
    '/api/2026-04/purchase_orders?page_size=2&page=2': {
      data: [{id:'PO3'}], links: {next:null}
    }
  });
  const data = await readLightspeedCollection({transport,path:'/api/2026-04/purchase_orders?page_size=2'});
  assert.deepEqual(data.map(x=>x.id), ['PO1','PO2','PO3']);
  assert.equal(transport.paths.length,2);
});
test('read pagination blocks cycles, untrusted URL, wrong shape and ambiguous full pages', async () => {
  const t1=fake({'/api/2026-04/items?page_size=1':{data:[{id:1}],links:{next:'?page_size=1'}}});
  await assert.rejects(readLightspeedCollection({transport:t1,path:'/api/2026-04/items?page_size=1'}),
    e=>e.code==='LIGHTSPEED_INCOMPLETE_READ');
  const t2=fake({'/api/2026-04/items?page_size=1':{data:[{id:1}],links:{next:'https://attacker.example/steal'}}});
  await assert.rejects(readLightspeedCollection({transport:t2,path:'/api/2026-04/items?page_size=1'}),
    e=>e.code==='LIGHTSPEED_INCOMPLETE_READ');
  const t3=fake({'/api/2026-04/items?page_size=1':{data:[{id:1}]}});
  await assert.rejects(readLightspeedCollection({transport:t3,path:'/api/2026-04/items?page_size=1'}),
    e=>e.code==='LIGHTSPEED_INCOMPLETE_READ');
  const t4=fake({'/api/2026-04/items?page_size=2':{unexpected:[]}});
  await assert.rejects(readLightspeedCollection({transport:t4,path:'/api/2026-04/items?page_size=2'}),
    e=>e instanceof LightspeedIncompleteReadError);
  const t5=fake({'/api/2026-04/items?page_size=2':{data:[{id:1},{id:2}],links:{next:null}}});
  assert.equal((await readLightspeedCollection({transport:t5,path:'/api/2026-04/items?page_size=2'})).length,2);
});
test('product exact matching keeps zeros, avoids digit-folding prefixed SKUs and rejects ambiguous identities', async () => {
  assert.deepEqual(findExactLightspeedProducts('ABC-123456',[{id:'P1',sku:'XYZ-123456'}]),[]);
  assert.equal(findExactLightspeedProducts('000012345678',[{id:'P1',upc:'000012345678'}]).length,1);
  assert.equal(findExactLightspeedProducts('123456',[{id:'P1',upc:'000012345678'}]).length,0);
  const a='/api/2026-07/products?sku=000123&page_size=1000';
  const b='/api/2026-07/search?type=products&sku=000123&page_size=20';
  const t=fake({[a]:{data:[{id:'P1',sku:'000123'}]},[b]:{data:[{id:'P1',sku:'000123'}]}});
  const read=createLightspeedProductsRead({transport:t});
  assert.equal((await read.exact('000123')).id,'P1');
  assert.equal(t.paths.length,2);
  const another=fake({[a]:{data:[{id:'P1',sku:'000123'}]},[b]:{data:[{id:'P2',sku:'000123'}]}});
  await assert.rejects(createLightspeedProductsRead({transport:another}).exact('000123'),
    e=>e.code==='LIGHTSPEED_AMBIGUOUS_IDENTITY' && e.matches.length===2);
});
test('product search fails closed if any independent vendor verification fails', async () => {
  const a='/api/2026-07/products?sku=abc&page_size=1000';
  const b='/api/2026-07/search?type=products&sku=abc&page_size=20';
  const t=fake({[a]:{data:[{id:'P1',sku:'ABC'}]},[b]:Error('upstream search unavailable')});
  await assert.rejects(createLightspeedProductsRead({transport:t}).exact('ABC'),/unavailable/);
});
test('PO read keeps supplier SKU/UPC strings and rejects missing list completeness', async () => {
  const first='/api/2026-04/purchase_orders?page_size=1000';
  const second='/api/2026-04/purchase_orders/PO1/line_items?page_size=1000';
  const t=fake({
    [first]:{data:[{id:'PO1',supplier_id:'S1',status:'OPEN',supplier:{name:'Vendor'}}]},
    [second]:{data:[{id:'L1',product_id:'P1',quantity_ordered:'4',supplier_sku:'0000123',upc:'0000012345678'}]}
  });
  const po=await createLightspeedPurchaseOrdersRead({transport:t}).get('PO1');
  assert.equal(po.supplier.id,'S1');
  assert.equal(po.lines[0].supplierSku,'0000123');
  assert.equal(po.lines[0].upc,'0000012345678');
  assert.equal(po.lines[0].quantity,4);
  assert.equal(t.paths.length,2);
  assert.equal(normalizeLightspeedPurchaseOrder({id:'PO2'},[{sku:'001'}]).lines[0].quantity,null);
  const incomplete=fake({[first]:{error:'not actually a list'}});
  await assert.rejects(createLightspeedPurchaseOrdersRead({transport:incomplete}).get('PO1'),
    e=>e.code==='LIGHTSPEED_INCOMPLETE_READ');
  const duplicate=fake({[first]:{data:[{id:'PO1'},{id:'PO1'}]}});
  await assert.rejects(createLightspeedPurchaseOrdersRead({transport:duplicate}).get('PO1'),
    e=>e.code==='LIGHTSPEED_INCOMPLETE_READ');
});
test('sales/fulfillment/inventory/credit read contracts preserve tested vendor endpoint versions', async () => {
  const t=fake({
    '/api/2.0/sales/S1': {data:{id:'S1'}},
    '/api/2.0/search?type=sales&invoice_number=000123&page_size=20': {data:[]},
    '/api/2.0/fulfillments?sale_id=S1': {data:[{id:'F1',sale_id:'S1',status:'NEW'}]},
    '/api/2026-04/inventory/P1': {data:{product_id:'P1',outlets:[{id:'O1',available:'2'}]}},
    '/api/2026-07/store_credits/C1': {data:{amount:'4.25'}}
  });
  const sales=createLightspeedSalesRead({transport:t});
  assert.equal((await sales.get('S1')).data.id,'S1');
  assert.deepEqual((await sales.byInvoice('000123')).data,[]);
  const fulfillment=(await createLightspeedFulfillmentsRead({transport:t}).forSale('S1'))[0];
  assert.equal(fulfillment.state,'NEW');
  const inventory=await createLightspeedInventoryRead({transport:t}).byProduct('P1');
  assert.equal(inventory.outlets[0].available,'2');
  assert.equal((await createLightspeedStoreCreditRead({transport:t}).get('C1')).data.amount,'4.25');
  await assert.rejects(createLightspeedInventoryRead({transport:fake({'/api/2026-04/inventory/P1':null})}).byProduct('P1'),
    e=>e.code==='LIGHTSPEED_INCOMPLETE_READ');
});
test('shared read gateway denies unauthenticated and unauthorized reads before vendor call', async () => {
  let called=0;
  const policy=createStaffLightspeedPolicy({
    verifyEmployeeRequest: async req => {
      if(req.get('authorization')!=='Bearer verified')throw Error('invalid session');
      return {id:'E1',active:true};
    },
    checkPermission:async ({operation})=>operation==='purchase-orders.read'
  });
  const router=createSharedLightspeedReadRouter({
    policy,
    customers:{search:async()=>{called++;return[];}},
    purchaseOrders:{get:async id=>{called++;return{id,status:'OPEN',lines:[],raw:{internal:'hidden'}};}}
  });
  const app=express();app.use('/api/hc-lightspeed',router);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try {
    const address='http://127.0.0.1:'+server.address().port;
    let r=await fetch(address+'/api/hc-lightspeed/purchase-orders/PO1');
    assert.equal(r.status,403);assert.equal(called,0);
    r=await fetch(address+'/api/hc-lightspeed/customers/search?q=Jane',{headers:{authorization:'Bearer verified'}});
    assert.equal(r.status,403);assert.equal(called,0);
    r=await fetch(address+'/api/hc-lightspeed/purchase-orders/PO1',{headers:{authorization:'Bearer verified'}});
    assert.equal(r.status,200);
    const response=await r.json();
    assert.equal(response.data.id,'PO1');
    assert.equal(response.data.raw,undefined);
    assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal(called,1);
    r=await fetch(address+'/api/hc-lightspeed/purchase-orders/invalid!id',{headers:{authorization:'Bearer verified'}});
    assert.equal(r.status,400);assert.equal(called,1);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
