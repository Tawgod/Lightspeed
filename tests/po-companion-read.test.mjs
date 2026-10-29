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
