import test from 'node:test';
import assert from 'node:assert/strict';
import {checkHcSecureDatabaseTarget,inspectFreshHcSecureDb,REQUIRED_TABLES}
 from '../scripts/check-hc-secure-fresh-db.mjs';

const env=()=>({
 RAILWAY_PROJECT_ID:'120de974-f2e8-46be-9a00-8eb8b1be4cc4',
 RAILWAY_ENVIRONMENT_ID:'8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c',
 HC_SECURE_PREPARE_DATABASE_URL:
  'postgresql://hc_preparer:fixture-only@hc-secure-postgres-staging.railway.internal:5432/hc_owner_stage_test'
});
function fixturePool(row){
 let queries=[],ended=0,released=0;
 const pool={
  connect:async()=>({query:async(sql,args=[])=>{
   queries.push(sql);
   if(sql==='BEGIN READ ONLY'||sql==='ROLLBACK')return {};
   assert.match(sql,/current_setting/);
   assert.match(sql,/to_regclass/);
   assert.deepEqual(args,[...REQUIRED_TABLES]);
   return {rows:[row],rowCount:1};
  },release:()=>{released++;}}),
  end:async()=>{ended++;}
 };
 return{pool,state:()=>({queries,ended,released})};
}
const blankRow=()=>({db:'hc_owner_stage_test',read_only:'on',
 ...Object.fromEntries(REQUIRED_TABLES.map((_,i)=>['t'+i,false]))});
test('fresh private HC Secure database target passes exact scopes',()=>{
 assert.deepEqual(checkHcSecureDatabaseTarget(env()),
  {host:'hc-secure-postgres-staging.railway.internal',database:'hc_owner_stage_test'});
});
test('refuses original project, original database, unsafe hosts, and credentials reused on shared DB',()=>{
 const cases=[
  {RAILWAY_PROJECT_ID:'5b46096d-3178-47ec-ba88-d5037696346a'},
  {RAILWAY_ENVIRONMENT_ID:'46b93c76-3085-4e76-a37d-90dfdd250dd2'},
  {HC_SECURE_PREPARE_DATABASE_URL:
   'postgresql://hc_preparer:fixture-only@Postgres-x8Ui.railway.internal/hc_owner_stage_test'},
  {HC_SECURE_PREPARE_DATABASE_URL:
   'postgresql://hc_preparer:fixture-only@hc-secure-postgres-staging.railway.internal/railway'},
  {HC_SECURE_PREPARE_DATABASE_URL:'postgres://hc_preparer:fixture-only@unapproved.example.test/hc_owner_stage_test'},
  {HC_OWNER_STAGING_DATABASE_URL:env().HC_SECURE_PREPARE_DATABASE_URL},
  {DATABASE_URL:env().HC_SECURE_PREPARE_DATABASE_URL}
 ];
 for(const c of cases)assert.throws(()=>checkHcSecureDatabaseTarget({...env(),...c}),/blocked/);
});
test('read-only transaction inspects fresh DB, releases client and closes pool',async()=>{
 const f=fixturePool(blankRow());
 assert.deepEqual(await inspectFreshHcSecureDb({
  environment:env(),createPool:()=>f.pool
 }),{fresh:true,requiredTablesAbsent:true,readOnly:true});
 assert.equal(f.state().queries[0],'BEGIN READ ONLY');
 assert.equal(f.state().queries.at(-1),'ROLLBACK');
 assert.deepEqual({released:f.state().released,ended:f.state().ended},{released:1,ended:1});
});
test('refuses partial/previous migrations and wrong db or read-write inspection',async()=>{
 const changed=[
  {...blankRow(),t0:true},
  {...blankRow(),t8:true},
  {...blankRow(),db:'railway'},
  {...blankRow(),read_only:'off'}
 ];
 for(const row of changed){
  const f=fixturePool(row);
  await assert.rejects(inspectFreshHcSecureDb({
   environment:env(),createPool:()=>f.pool
  }),/blocked/);
  assert.equal(f.state().released,1);
  assert.equal(f.state().ended,1);
 }
});
test('bad target fails before any DB pool is created',async()=>{
 let created=false;
 await assert.rejects(inspectFreshHcSecureDb({
  environment:{...env(),RAILWAY_PROJECT_ID:'wrong'},
  createPool:()=>{created=true;throw Error('should not connect');}
 }),/blocked/);
 assert.equal(created,false);
});
