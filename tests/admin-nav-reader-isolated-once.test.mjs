import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionAdminReader,validateAdminReaderSetup} from '../scripts/admin-nav-reader-isolated-once.mjs';

const env={
 HC_ADMIN_SCHEMA_MIGRATION_ENABLED:'true',HC_ADMIN_SCHEMA_MIGRATION_TARGET:'Postgres-O39p',
 HC_ADMIN_SCHEMA_MIGRATION_ENVIRONMENT:'test',
 HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_HOST:'postgres-o39p.railway.internal',
 HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_DB:'railway',
 HC_ADMIN_SCHEMA_DATABASE_URL:'postgres://postgres:example@postgres-o39p.railway.internal:5432/railway',
 HC_ADMIN_READER_PROVISION_ENABLED:'true',
 HC_ADMIN_NAV_READER_PASSWORD:'A'.repeat(64)
};
test('reader setup refuses wrong database or missing dedicated credential',()=>{
 assert.equal(validateAdminReaderSetup(env).role,'hc_admin_nav_reader');
 for(const change of [
  {HC_ADMIN_READER_PROVISION_ENABLED:'false'},
  {HC_ADMIN_NAV_READER_PASSWORD:'short'},
  {HC_ADMIN_NAV_READER_PASSWORD:'a'.repeat(40)+'$!'},
  {HC_ADMIN_SCHEMA_MIGRATION_TARGET:'Postgres'},
  {HC_ADMIN_SCHEMA_MIGRATION_ENVIRONMENT:'production'}
 ])assert.throws(()=>validateAdminReaderSetup({...env,...change}),/refused/);
});
function mock({alreadyPopulated=false,readWrite=false,fail=false}={}){
 const commands=[],calls=[];
 const client={
  async query(sql,params){
   commands.push({sql,params});
   if(fail&&sql.includes('ALTER ROLE hc_admin_nav_reader SET'))throw Error('forced failed role setup');
   if(sql.includes('current_database'))return {rowCount:1,rows:[{name:'railway'}]};
   if(sql.includes("to_regclass("))return {rows:[{principals:true,grants:true}]};
   if(sql.includes('AS owners'))return {rows:[{owners:alreadyPopulated?1:0,grants:0}]};
   if(sql.includes('AS principals_read'))return {rowCount:1,rows:[{
    principals_read:true,grants_read:true,principals_write:readWrite,grants_write:false,can_create:false
   }]};
   return {rowCount:0,rows:[]};
  },
  release(){calls.push('release')}
 };
 return {commands,calls,poolFactory:()=>({connect:async()=>client,end:async()=>calls.push('end')})};
}
test('reader role uses parameterized secret, grants SELECT only and commits',async()=>{
 const m=mock();
 const result=await provisionAdminReader({env,poolFactory:m.poolFactory});
 assert.deepEqual(result,{readerReady:true,role:'hc_admin_nav_reader',principals:0,grants:0});
 const sql=m.commands.map(x=>x.sql).join('\n');
 assert.match(sql,/CREATE ROLE hc_admin_nav_reader NOLOGIN/);
 assert.match(sql,/GRANT SELECT ON public.hc_admin_principals,public.hc_admin_grants/);
 assert.match(sql,/ALTER ROLE hc_admin_nav_reader LOGIN PASSWORD %L/);
 assert.doesNotMatch(sql,/A{48}/);
 assert.equal(m.commands.filter(x=>x.params?.[0]===env.HC_ADMIN_NAV_READER_PASSWORD).length,1);
 assert.equal(m.commands.at(-1).sql,'COMMIT');
 assert.deepEqual(m.calls,['release','end']);
});
test('populated schema, excessive privileges or failure abort and rollback',async()=>{
 for(const scenario of [{alreadyPopulated:true},{readWrite:true},{fail:true}]){
  const m=mock(scenario);
  await assert.rejects(provisionAdminReader({env,poolFactory:m.poolFactory}));
  const queries=m.commands.map(x=>x.sql);
  assert.ok(queries.includes('ROLLBACK'));
  assert.ok(!queries.includes('COMMIT'));
  assert.deepEqual(m.calls,['release','end']);
 }
});
