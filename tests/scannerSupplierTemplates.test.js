import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createScannerSupplierTemplatesRouter,initializeScannerSupplierTemplates} from '../services/scannerSupplierTemplates.js';

async function serve(identity){
  const express=(await import('express')).default;
  const app=express();
  const queries=[];
  const pool={query:async(sql,args=[])=>{
    queries.push({sql,args});
    if(sql.startsWith('SELECT'))return {rows:[]};
    return {rows:[{domain:args[0],supplier_name:args[1],status:'REFERENCE'}]};
  }};
  app.use('/api/scanner',createScannerSupplierTemplatesRouter({pool,verifyEmployee:async()=>identity}));
  const server=createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,queries,url:'http://127.0.0.1:'+server.address().port};
}
const tinyJpeg='data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64');
async function request(ctx,method,path,body){
  return fetch(ctx.url+'/api/scanner'+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
}
test('initialization creates isolated supplier snapshot registry',async()=>{
 const sql=[];
 await initializeScannerSupplierTemplates({query:async s=>{sql.push(s);}});
 assert.match(sql[0],/CREATE TABLE IF NOT EXISTS scanner_supplier_templates/);
 assert.match(sql[0],/status IN \('REFERENCE','REVIEWED'\)/);
});
test('lookup permission cannot upload or overwrite shared snapshots',async()=>{
 const ctx=await serve({id:5,canLookup:true,canApprove:false});
 try{
  assert.equal((await request(ctx,'PUT','/templates/acdd.com',{domain:'acdd.com',supplierName:'ACD',image:tinyJpeg})).status,403);
  assert.equal(ctx.queries.length,0);
  assert.equal((await request(ctx,'GET','/templates')).status,200);
 }finally{ctx.server.close();}
});
test('approved employee can store a reference without automatically approving selectors',async()=>{
 const ctx=await serve({id:7,canLookup:true,canApprove:true});
 try{
  const res=await request(ctx,'PUT','/templates/acdd.com',{domain:'acdd.com',supplierName:'ACD Distribution',image:tinyJpeg,selectors:{upc:'[itemprop=gtin12]'}});
  assert.equal(res.status,200);
  assert.equal((await res.json()).template.status,'REFERENCE');
  assert.equal(ctx.queries[0].args[4],7);
  assert.equal(ctx.queries[0].args[0],'acdd.com');
 }finally{ctx.server.close();}
});
test('rejects domain mismatch, disallowed selectors and non-JPEG image',async()=>{
 const ctx=await serve({id:7,canLookup:true,canApprove:true});
 try{
  const b={domain:'acdd.com',supplierName:'ACD',image:tinyJpeg};
  assert.equal((await request(ctx,'PUT','/templates/another.com',b)).status,400);
  assert.equal((await request(ctx,'PUT','/templates/acdd.com',{...b,selectors:{untrusted:'x'}})).status,400);
  assert.equal((await request(ctx,'PUT','/templates/acdd.com',{...b,image:'data:image/png;base64,AAAA'})).status,400);
  assert.equal(ctx.queries.length,0);
 }finally{ctx.server.close();}
});
