import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {createScannerIsolatedTestWriter} from '../services/scannerIsolatedTestWriter.js';
import {createScannerTestCreationRouter,initializeScannerTestCreation} from '../services/scannerTestCreationRouter.js';
const params={enabled:true,domain:'hobby-corner-sandbox',productionDomain:'hobby-corner-live',token:'private-test-only',confirmation:'ISOLATED_TEST_TENANT'};
test('test writer refuses production domain, incomplete config and invalid token',()=>{
 for(const config of [
  {...params,domain:params.productionDomain},
  {...params,productionDomain:''},
  {...params,token:''},
  {...params,confirmation:'wrong'},
  {...params,enabled:false},
  {...params,domain:'hobby-corner-live.evil.test'}
 ])assert.equal(createScannerIsolatedTestWriter(config),null);
});
test('test writer queries only sandbox SKU and creates an inactive item there',async()=>{
 const calls=[];
 const writer=createScannerIsolatedTestWriter({...params,fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(options.method==='GET')return {ok:true,json:async()=>({data:[]})};
  return {ok:true,json:async()=>({data:{id:'test-123'}})};
 }});
 const product=await writer({name:'Beta product',sku:'BETA-1',supplierSku:'ACD-1',cost:'5.75',description:'Test'});
 assert.equal(product.id,'test-123');
 assert.equal(calls.length,2);
 assert.ok(calls.every(c=>c.url.startsWith('https://hobby-corner-sandbox.retail.lightspeed.app/api/2026-07/products')));
 const posted=JSON.parse(calls[1].options.body);
 assert.equal(posted.is_active,false);
 assert.equal(posted.sku,'BETA-1');
 assert.equal(posted.supplier_code,'ACD-1');
 assert.equal(posted.supply_price,5.75);
 assert.equal(posted.inventory,undefined);
});
test('existing sandbox SKU blocks POST',async()=>{
 const methods=[];
 const writer=createScannerIsolatedTestWriter({...params,fetchImpl:async(url,options)=>{
  methods.push(options.method);return {ok:true,json:async()=>({data:[{id:1}]})};
 }});
 await assert.rejects(()=>writer({name:'Already',sku:'ABC'}),/already exists/);
 assert.deepEqual(methods,['GET']);
});
async function mockRouter({employee={id:1,canLookup:true},existing=[],writer=async()=>({id:'t1',sku:'A'})}={}){
 const calls=[];let claimed=false;
 const pool={query:async(sql,args=[])=>{
  calls.push({sql,args});
  if(sql.includes('FROM scanner_product_review_proposals WHERE id=$1'))return {rows:[{id:3,status:'PENDING_REVIEW',product_payload:{name:'Test',sku:'A',upc:'850052382605'}}]};
  if(sql.includes('INSERT INTO scanner_test_creation_attempts')){if(claimed)return {rows:[]};claimed=true;return {rows:[{id:8}]};}
  return {rows:[]};
 }};
 const app=express();
 app.use('/api/scanner',createScannerTestCreationRouter({pool,verifyEmployee:async()=>employee,
  lookup:async()=>({matches:existing}),testWriter:writer}));
 const server=createServer(app);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 return {server,calls,base:'http://127.0.0.1:'+server.address().port+'/api/scanner'};
}
test('one confirmed sandbox create attempt, duplicate rechecks and no blind retry',async()=>{
 const h=await mockRouter();
 try{
  const body=JSON.stringify({confirmation:'CREATE TEST PRODUCT',expectedSku:'A'});
  const url=h.base+'/product-proposals/3/test-create';
  let r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body});
  assert.equal(r.status,201);assert.equal((await r.json()).product.id,'t1');
  r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body});
  assert.equal(r.status,409);
  assert.ok(h.calls.some(c=>c.sql.includes("status='CREATED'")));
 }finally{h.server.close();}
});
test('no sandbox writer exposes a write path; inactive employee denied',async()=>{
 const h=await mockRouter({writer:null});
 try{
  const r=await fetch(h.base+'/product-proposals/3/test-create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:'CREATE TEST PRODUCT'})});
  assert.equal(r.status,503);assert.equal(h.calls.length,0);
 }finally{h.server.close();}
 const x=await mockRouter({employee:{id:1,canLookup:false}});
 try{
  const r=await fetch(x.base+'/product-proposals/3/test-create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:'CREATE TEST PRODUCT'})});
  assert.equal(r.status,403);
 }finally{x.server.close();}
});
test('test attempt schema permits only audited results',async()=>{
 let q='';await initializeScannerTestCreation({query:async sql=>q=sql});
 assert.match(q,/UNIQUE REFERENCES scanner_product_review_proposals/);
 assert.match(q,/RECONCILE_REQUIRED/);
});
