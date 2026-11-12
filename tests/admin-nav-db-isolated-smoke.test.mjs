import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAdminSmokeTarget,verifyIsolatedAdminNavigation} from '../scripts/admin-nav-db-isolated-smoke.mjs';

const env={
 HC_ADMIN_NAV_SMOKE_ENABLED:'true',HC_ADMIN_NAV_SMOKE_ENVIRONMENT:'test',
 HC_ADMIN_NAV_SMOKE_TARGET:'Postgres-O39p',
 HC_ADMIN_NAV_SMOKE_HOST:'postgres-o39p.railway.internal',
 HC_ADMIN_NAV_SMOKE_DATABASE:'railway',
 HC_ADMIN_NAV_READER_PASSWORD:'A'.repeat(64)
};
test('isolated navigation smoke refuses missing or wrong connection inputs',()=>{
 const target=validateAdminSmokeTarget(env);
 assert.equal(target.host,'postgres-o39p.railway.internal');
 for(const change of [
  {HC_ADMIN_NAV_SMOKE_ENABLED:'false'},
  {HC_ADMIN_NAV_SMOKE_TARGET:'Postgres'},
  {HC_ADMIN_NAV_SMOKE_ENVIRONMENT:'production'},
  {HC_ADMIN_NAV_SMOKE_HOST:'public.example.com'},
  {HC_ADMIN_NAV_READER_PASSWORD:'short'}
 ])assert.throws(()=>validateAdminSmokeTarget({...env,...change}),/refused/);
});
test('read-only login and empty principal/grant tables succeed without changes',async()=>{
 const statements=[],calls=[];
 const poolFactory=options=>{
  assert.equal(options.user,'hc_admin_nav_reader');
  assert.equal(options.database,'railway');
  return {
   async query(sql,params){
    statements.push({sql,params});
    if(sql.includes('current_database() AS database'))return {rowCount:1,rows:[{database:'railway',login:'hc_admin_nav_reader'}]};
    if(sql.includes('principals_exists'))return {rowCount:1,rows:[{
     principals_exists:true,grants_exists:true,principals_read:true,grants_read:true,
     principals_write:false,grants_write:false,schema_write:false
    }]};
    if(sql.includes('count(*)'))return {rowCount:1,rows:[{n:0}]};
    if(sql.includes('SELECT 1 FROM'))return {rowCount:0,rows:[]};
    throw Error('Unexpected query');
   },
   async end(){calls.push('end')}
  };
 };
 const r=await verifyIsolatedAdminNavigation({env,poolFactory});
 assert.deepEqual(r,{readOnlyConnected:true,principals:0,grants:0,service:'Postgres-O39p'});
 assert.ok(statements.every(x=>x.sql.trim().startsWith('SELECT')));
 assert.equal(calls.length,1);
});
test('failed least privilege and preexisting staff roles refuse and close connection',async()=>{
 for(const failed of ['writable','populated']){
  let closed=false;
  await assert.rejects(verifyIsolatedAdminNavigation({
   env,poolFactory:()=>({
    query:async sql=>{
     if(sql.includes('current_database()'))return {rowCount:1,rows:[{database:'railway',login:'hc_admin_nav_reader'}]};
     if(sql.includes('principals_exists'))return {rowCount:1,rows:[{
      principals_exists:true,grants_exists:true,principals_read:true,grants_read:true,
      principals_write:failed==='writable',grants_write:false,schema_write:false
     }]};
     return {rows:[{n:1}],rowCount:1};
    },end:async()=>{closed=true}
   })
  }));
  assert.equal(closed,true);
 }
});
