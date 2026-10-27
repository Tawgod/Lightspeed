import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {createScannerProductReviewRouter,initializeScannerProductReviewQueue} from '../services/scannerProductReviewQueue.js';

const product={name:'Starter Set',sku:'ACD-14',supplierSku:'ACD-14',upc:'850052382605',cost:'19.99',msrp:'39.99',mapPrice:'34.99'};
const payload={supplierId:7,product,sourceUrl:'https://example-supplier.com/products/starter-set'};
async function harness({employee={id:11,canLookup:true,canApprove:false},local=[],remote=[],failRemote=false,duplicate=false}={}){
 const calls=[];let lookups=[];
 const pool={query:async(sql,args=[])=>{
  calls.push({sql,args});
  if(sql.includes('INSERT INTO scanner_product_review_proposals'))return {rows:duplicate?[]:[{id:42,status:'PENDING_REVIEW',submitted_at:'2026-10-27T10:00:00Z'}]};
  if(sql.includes('FROM scanner_product_review_proposals WHERE id=$1'))return {rows:[{id:42,status:'PENDING_REVIEW'}]};
  if(sql.includes('FROM scanner_product_review_proposals ORDER BY'))return {rows:[]};
  return {rows:[]};
 }};
 const lookup=async(kind,request)=>{
  lookups.push({kind,request});
  if(kind==='remote'&&failRemote)throw new Error('remote unavailable');
  return {matches:kind==='remote'?remote:local};
 };
 const app=express();
 app.use('/api/scanner',createScannerProductReviewRouter({pool,verifyEmployee:async()=>employee,lookup}));
 const server=createServer(app);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {server,calls,lookups,base:'http://127.0.0.1:'+server.address().port+'/api/scanner'};
}
const request=(h,path,body,method='POST')=>fetch(h.base+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
test('schema persists proposals away from product/inventory tables',async()=>{
 const statements=[];
 await initializeScannerProductReviewQueue({query:async sql=>statements.push(sql)});
 assert.match(statements[0],/CREATE TABLE IF NOT EXISTS scanner_product_review_proposals/);
 assert.match(statements[0],/PENDING_REVIEW/);
 assert.match(statements[0],/UNIQUE\(supplier_id,item_key\)/);
 assert.doesNotMatch(statements[0],/CREATE TABLE.*preorder_products/);
});
test('active lookup-only employee can submit after two server-side duplicate checks',async()=>{
 const h=await harness();
 try{
  const response=await request(h,'/product-proposals',payload);
  assert.equal(response.status,201);
  assert.equal((await response.json()).proposal.status,'PENDING_REVIEW');
  assert.deepEqual(h.lookups.map(x=>x.kind),['local','remote']);
  assert.equal(h.lookups[0].request.supplier_id,undefined);
  const insert=h.calls.find(x=>x.sql.includes('INSERT INTO scanner_product_review_proposals'));
  assert.ok(insert);
  assert.match(insert.sql,/ON CONFLICT \(supplier_id,item_key\) DO NOTHING/);
  assert.equal(insert.args[1],'upc:850052382605');
 }finally{h.server.close();}
});
test('existing local or Lightspeed result blocks new-item proposal',async()=>{
 for(const options of [{local:[{id:1}]},{remote:[{id:'ls-1'}]}]){
  const h=await harness(options);
  try{assert.equal((await request(h,'/product-proposals',payload)).status,409);
   assert.equal(h.calls.filter(x=>x.sql.includes('INSERT')).length,0);
  }finally{h.server.close();}
 }
});
test('remote lookup errors cannot be treated as no-match',async()=>{
 const h=await harness({failRemote:true});
 try{
  assert.equal((await request(h,'/product-proposals',payload)).status,503);
  assert.equal(h.calls.length,0);
 }finally{h.server.close();}
});
test('inactive employee and invalid product/source cannot submit',async()=>{
 const h=await harness({employee:{id:11,canLookup:false}});
 try{assert.equal((await request(h,'/product-proposals',payload)).status,403);assert.equal(h.lookups.length,0);}
 finally{h.server.close();}
 const v=await harness();
 try{
  assert.equal((await request(v,'/product-proposals',{...payload,sourceUrl:'http://example.com'})).status,400);
  assert.equal((await request(v,'/product-proposals',{...payload,product:{...product,upc:'123'}})).status,400);
  assert.equal(v.lookups.length,0);
 }finally{v.server.close();}
});
test('duplicate review proposal remains unchanged',async()=>{
 const h=await harness({duplicate:true});
 try{assert.equal((await request(h,'/product-proposals',payload)).status,409);}
 finally{h.server.close();}
});
test('no product approval, Lightspeed write or Discord route exists',async()=>{
 const h=await harness();
 try{
  assert.equal((await request(h,'/product-proposals/42/approve',{},'POST')).status,404);
  assert.equal((await request(h,'/product-proposals/42',{},'PATCH')).status,404);
  assert.equal(h.calls.length,0);
 }finally{h.server.close();}
});
