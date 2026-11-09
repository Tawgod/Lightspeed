import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {readFileSync} from 'node:fs';
import {createAdminNavigationAccessRouter,createAdminNavigationGrantReader,verifyAdminNavigationReadOnlyDatabase} from '../services/security/adminNavigationAccess.js';

test('exact admin.read grant reader is read-only, default-deny and never commissions Owner',async()=>{
 const queries=[];
 const pool={query:async(text,values)=>{
  queries.push({text,values});
  return {rowCount:values[0]==='901'?1:0};
 }};
 const canRead=createAdminNavigationGrantReader({pool});
 assert.equal(await canRead({employeeId:'901',operation:'admin.read'}),true);
 assert.equal(await canRead({employeeId:'902',operation:'admin.read'}),false);
 assert.equal(await canRead({employeeId:'901',operation:'admin.delegation.manage'}),false);
 assert.equal(await canRead({employeeId:'not-a-valid-id',operation:'admin.read'}),false);
 assert.equal(queries.length,2);
 assert.ok(queries.every(q=>/^SELECT 1 FROM/.test(q.text.trim())));
 assert.ok(queries.every(q=>!/(?:\bINSERT\b|\bDELETE\b|\bUPDATE\b|\bCREATE\b)/.test(q.text)));
 assert.match(queries[0].text,/p\.active=TRUE/);
 assert.match(queries[0].text,/g\.operation='admin.read'/);
 assert.deepEqual(queries[0].values,['901']);
 const unavailable=createAdminNavigationGrantReader({pool:{query:async()=>{throw Error('table missing')}}});
 assert.equal(await unavailable({employeeId:'901',operation:'admin.read'}),false);
});
test('admin grant database preflight rejects write-capable and missing-schema credentials',async()=>{
 const good={
  principals_exists:true,grants_exists:true,principals_read:true,grants_read:true,
  principals_write:false,grants_write:false,schema_write:false
 };
 let query;
 const check=async values=>verifyAdminNavigationReadOnlyDatabase({pool:{query:async sql=>{
  query=sql;return {rowCount:1,rows:[values]};
 }}});
 assert.equal(await check(good),true);
 assert.match(query,/has_table_privilege/);
 assert.match(query,/has_schema_privilege/);
 for(const change of [
  {principals_write:true},{grants_write:true},{schema_write:true},
  {principals_exists:false},{grants_exists:false},
  {principals_read:false},{grants_read:false}
 ])assert.equal(await check({...good,...change}),false);
 assert.equal(await verifyAdminNavigationReadOnlyDatabase({pool:{query:async()=>{throw Error('no schema')}}}),false);
 assert.equal(await verifyAdminNavigationReadOnlyDatabase({}),false);
});
test('same-origin navigation route denies PIN-only spoof, inactive/invalid identity and ungranted staff',async()=>{
 let active='901',signed=true,granted=false,queries=0;
 const router=createAdminNavigationAccessRouter({
  verifyEmployee:async(req)=>{
   if(!signed||req.get('authorization')!=='Bearer signed-fixture')throw Error('bad token');
   return {id:active,name:'Employee Fixture',active:true,role:'owner'};
  },
  hasAdminRead:async({employeeId,operation})=>{
   queries++;
   assert.equal(operation,'admin.read');
   return granted&&employeeId==='901';
  }
 });
 const app=express();app.use('/api/admin',router);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const uri='http://127.0.0.1:'+server.address().port+'/api/admin/navigation-access';
  const get=(headers={})=>fetch(uri,{headers});
  let res=await get();
  assert.equal(res.status,403);
  assert.match(res.headers.get('cache-control'),/no-store/);
  assert.equal(queries,0);
  res=await get({'x-hc-role':'owner','x-employee-id':'901'});
  assert.equal(res.status,403);
  active='901';
  res=await get({Authorization:'Bearer signed-fixture'});
  assert.equal(res.status,403);
  granted=true;
  res=await get({Authorization:'Bearer signed-fixture'});
  assert.equal(res.status,200);
  assert.deepEqual(await res.json(),{allowed:true,authenticated:true,operation:'admin.read'});
  active='902';
  assert.equal((await get({Authorization:'Bearer signed-fixture'})).status,403);
  active='901';signed=false;
  assert.equal((await get({Authorization:'Bearer signed-fixture'})).status,403);
  assert.equal((await fetch(uri,{method:'POST'})).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('feature gate does not attach Admin route unless separately enabled and dedicated database configured',()=>{
 const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(server,/HC_ADMIN_NAV_ENABLED==='true'/);
 assert.match(server,/HC_ADMIN_GRANTS_DATABASE_URL/);
 assert.match(server,/verifyEmployee:staffAuth\.verifyEmployee/);
 assert.match(server,/hasAdminRead:createAdminNavigationGrantReader/);
 assert.match(server,/await verifyAdminNavigationReadOnlyDatabase/);
 assert.doesNotMatch(server,/HC_ADMIN_GRANTS_DATABASE_URL\s*\|\|\s*process\.env\.DATABASE_URL/);
});
