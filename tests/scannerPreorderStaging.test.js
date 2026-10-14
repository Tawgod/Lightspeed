import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {initializeScannerPreorderStaging,createScannerPreorderRouter} from '../services/scannerPreorderStaging.js';

async function setup(employee={id:2,canLookup:true,canApprove:true}){
 const calls=[];
 const pool={query:async(sql,args=[])=>{
   calls.push({sql,args});
   if(sql.startsWith('SELECT id,name,status,campaign_type'))return {rows:[{id:5,name:'Fall Preorders',status:'OPEN',campaign_type:'STANDARD'}]};
   if(sql.includes('RETURNING id,item_name,status'))return {rows:[{id:10,item_name:args[3],status:'PENDING_REVIEW'}]};
   return {rows:[]};
 }};
 const app=express();
 app.use('/api/scanner',createScannerPreorderRouter({pool,verifyEmployee:async()=>employee}));
 const server=createServer(app);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/api/scanner';
 return {pool,calls,server,base};
}
async function req(ctx,path,{method='GET',body}={}){
 return fetch(ctx.base+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
}
const item={supplierId:7,product:{name:'Example Game',upc:'850052382605',sku:'STORE1',supplierSku:'ACD123',msrp:'74.99',mapPrice:'59.99'},sourceUrl:'https://www.acdd.com/p/123'};
test('schema is separated from published preorder_products and defaults to pending review',async()=>{
 const queries=[];await initializeScannerPreorderStaging({query:async(sql)=>queries.push(sql)});
 assert.match(queries[0],/CREATE TABLE IF NOT EXISTS scanner_preorder_staged_items/);
 assert.match(queries[0],/PENDING_REVIEW/);
 assert.doesNotMatch(queries[0],/REFERENCES preorder_products/);
});
test('manager sees active campaign choices and stages a pending item without Discord',async()=>{
 const ctx=await setup();
 try{
  const campaigns=await req(ctx,'/preorder-campaigns');
  assert.equal(campaigns.status,200);
  assert.equal((await campaigns.json()).campaigns[0].name,'Fall Preorders');
  const staged=await req(ctx,'/preorder-campaigns/5/staged',{method:'POST',body:item});
  assert.equal(staged.status,201);
  assert.equal((await staged.json()).item.status,'PENDING_REVIEW');
  const sql=ctx.calls.find(x=>x.sql.includes('INSERT INTO scanner_preorder_staged_items'));
  assert.ok(sql);
  assert.match(sql.sql,/ON CONFLICT\(campaign_id,item_key\) DO NOTHING/);
  assert.doesNotMatch(sql.sql,/discord|preorder_products/i);
  assert.equal(sql.args[0],5);
  assert.equal(sql.args[1],7);
  assert.equal(sql.args[2],'upc:850052382605');
 }finally{ctx.server.close();}
});
test('lookup only cannot stage items, but can see campaigns',async()=>{
 const ctx=await setup({id:1,canLookup:true,canApprove:false});
 try{
  assert.equal((await req(ctx,'/preorder-campaigns')).status,200);
  assert.equal((await req(ctx,'/preorder-campaigns/5/staged',{method:'POST',body:item})).status,403);
  assert.equal(ctx.calls.length,1);
 }finally{ctx.server.close();}
});
test('reject invalid campaign, missing supplier and bad price without a write',async()=>{
 const ctx=await setup();
 try{
  assert.equal((await req(ctx,'/preorder-campaigns/xyz/staged',{method:'POST',body:item})).status,400);
  assert.equal((await req(ctx,'/preorder-campaigns/5/staged',{method:'POST',body:{...item,supplierId:null}})).status,400);
  assert.equal((await req(ctx,'/preorder-campaigns/5/staged',{method:'POST',body:{...item,product:{...item.product,msrp:'74.99;DROP'}}})).status,400);
  assert.equal(ctx.calls.filter(x=>x.sql.includes('INSERT')).length,0);
 }finally{ctx.server.close();}
});
