import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoCompanionReadRouter} from '../routes/poCompanionRead.js';
import express from 'express';
async function serve({employee={id:1,canLookup:true},supplier={id:2,name:'Vendor'},product={lightspeed_product_id:'A',upc:'00004567',supplier_sku:'00000123',name:'Widget'}}={}){
 const routes=[];
 const pool={async query(sql,params){if(sql.includes('FROM suppliers'))return {rows:supplier?[supplier]:[]};if(sql.includes('FROM products'))return {rows:product?[product]:[]};throw Error('Unexpected SQL');}};
 const read=async endpoint=>endpoint.includes('line_items')?{data:[{id:'line1',product_id:'A',quantity:2,name:'Widget'}]}:{data:[{id:'po1',supplier_id:'vendor-x',status:'OPEN'}]};
 const app=express();app.use('/api',createPoCompanionReadRouter({verifyEmployee:async()=>{if(!employee)throw Object.assign(new Error('Unauthorized'),{status:401});return employee;},readLightspeed:read,pool}));
 const server=app.listen(0);await new Promise(r=>server.once('listening',r));return {url:'http://127.0.0.1:'+server.address().port+'/api/purchase-orders/po1',close:()=>new Promise(r=>server.close(r))};
}
test('authenticated read returns exact leading-zero identifiers',async()=>{const s=await serve();try{const r=await fetch(s.url);assert.equal(r.status,200);const j=await r.json();assert.equal(j.readOnly,true);assert.equal(j.items[0].supplierSku,'00000123');assert.equal(j.items[0].upc,'00004567');}finally{await s.close()}});
test('denied employee cannot read PO',async()=>{const s=await serve({employee:{id:1,canLookup:false}});try{assert.equal((await fetch(s.url)).status,403)}finally{await s.close()}});
test('missing supplier never uses product supplier SKU',async()=>{const s=await serve({supplier:null});try{const j=await(await fetch(s.url)).json();assert.equal(j.items[0].supplierSku,'');assert.ok(j.items[0].warnings.includes('SUPPLIER_UNRESOLVED'));}finally{await s.close()}});

test('opt-in shared PO reader preserves local supplier mapping and exact identifiers',async()=>{
 const calls=[];
 const sharedPurchaseOrders={async get(id){calls.push(id);return {
  id:'po1',status:'OPEN',supplier:{id:'vendor-x',name:'Vendor'},
  lines:[{id:'line1',productId:'A',productName:'Widget',quantity:2,
   supplierSku:'remote-ignored',sku:'0000009',upc:'00005678',raw:{id:'line1',product_id:'A',quantity:2}}]
 }}};
 const pool={async query(sql){if(sql.includes('FROM suppliers'))return {rows:[{id:2,name:'Vendor'}]};if(sql.includes('FROM products'))return {rows:[{lightspeed_product_id:'A',name:'Widget',upc:'00004567',supplier_sku:'00000123',sku:'00000999',supply_price:'1.25'}]};throw Error('Unexpected SQL')}};
 let legacyCalls=0;
 const app=express();app.use('/api',createPoCompanionReadRouter({
  verifyEmployee:async()=>({id:'employee',canLookup:true}),pool,sharedPurchaseOrders,
  readLightspeed:async()=>{legacyCalls++;throw Error('Legacy reader must not be used')}
 }));
 const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/purchase-orders/po1');
  assert.equal(response.status,200);
  const result=await response.json();
  assert.deepEqual(calls,['po1']);assert.equal(legacyCalls,0);
  assert.equal(result.readOnly,true);
  assert.equal(result.purchaseOrder.supplier.localId,2);
  assert.equal(result.purchaseOrder.supplier.lightspeedId,'vendor-x');
  assert.equal(result.items[0].supplierSku,'00000123');
  assert.equal(result.items[0].upc,'00004567');
  assert.equal(result.items[0].quantity,2);
  assert.equal(result.items[0].original.supplierCost,'1.25');
 }finally{await new Promise(resolve=>server.close(resolve))}
});
test('shared PO reader fails closed on incomplete response, with no legacy fallback',async()=>{
 let calls=0;
 const app=express();app.use('/api',createPoCompanionReadRouter({
  verifyEmployee:async()=>({id:1,canLookup:true}),
  pool:{async query(){throw Error('Should not map incomplete records')}},
  sharedPurchaseOrders:{async get(){return {id:'po1'}}},
  readLightspeed:async()=>{calls++;return {data:[]}}
 }));
 const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/purchase-orders/po1');
  assert.equal(response.status,502);assert.equal(calls,0);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
test('shared reader still enforces employee lookup denial before API or database use',async()=>{
 let calls=0;
 const app=express();app.use('/api',createPoCompanionReadRouter({
  verifyEmployee:async()=>({id:1,canLookup:false}),
  pool:{async query(){calls++;throw Error('Unexpected DB call')}},
  sharedPurchaseOrders:{async get(){calls++;throw Error('Unexpected PO call')}}
 }));
 const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/purchase-orders/po1');
  assert.equal(response.status,403);assert.equal(calls,0);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
