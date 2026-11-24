import test from 'node:test';
import assert from 'node:assert/strict';
import {checkHcSecureBootstrapScope,bootstrapHcSecureStagingDb}
 from '../scripts/bootstrap-hc-secure-staging-db.mjs';
const url='postgresql://postgres:fixture-only-password-123456@hc-secure-postgres-staging.railway.internal:5432/railway';
const env=()=>({
 RAILWAY_PROJECT_ID:'120de974-f2e8-46be-9a00-8eb8b1be4cc4',
 RAILWAY_ENVIRONMENT_ID:'8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c',
 RAILWAY_SERVICE_NAME:'hc-secure-db-bootstrap-once',
 HC_SECURE_DB_BOOTSTRAP_ONLY:'true',
 HC_SECURE_DB_MUTATION_APPROVED:'HC_SECURE_FRESH_DB_SCHEMA_ONLY',
 HC_SECURE_BOOTSTRAP_ROOT_URL:url
});
test('correct new HC Secure-only one-shot bootstrap scope is accepted',()=>{
 const x=checkHcSecureBootstrapScope(env());
 assert.equal(x.hostname,'hc-secure-postgres-staging.railway.internal');
 assert.equal(x.pathname,'/railway');
});
test('rejects original Owner project, wrong service and unauthorized bootstraps',()=>{
 const examples=[
  {RAILWAY_PROJECT_ID:'5b46096d-3178-47ec-ba88-d5037696346a'},
  {RAILWAY_ENVIRONMENT_ID:'46b93c76-3085-4e76-a37d-90dfdd250dd2'},
  {RAILWAY_SERVICE_NAME:'hc-secure-auth-staging'},
  {HC_SECURE_DB_BOOTSTRAP_ONLY:'false'},
  {HC_SECURE_DB_MUTATION_APPROVED:'false'},
  {HC_OWNER_STAGING_ENABLED:'true'},
  {HC_STAGING_TEST_LOGIN_ENABLED:'true'},
  {OWNER_STAGING_IDENTITY_ENABLED:'true'},
  {DATABASE_URL:url},
  {HC_OWNER_STAGING_DATABASE_URL:url},
  {LIGHTSPEED_TOKEN:'unsafe'},
  {HC_OWNER_DB_RUNTIME_PASSWORD:'do-not-copy'},
  {HC_SECURE_BOOTSTRAP_ROOT_URL:url.replace('hc-secure-postgres-staging','Postgres-x8Ui')},
  {HC_SECURE_BOOTSTRAP_ROOT_URL:url.replace('/railway','/hc_owner_stage_test')},
  {HC_SECURE_BOOTSTRAP_ROOT_URL:url.replace('fixture-only-password-123456','short')},
 ];
 for(const item of examples){
  assert.throws(()=>checkHcSecureBootstrapScope({...env(),...item}),/refused/);
 }
});
test('invalid Railway scope rejects before creating any database client',async()=>{
 let created=false;
 await assert.rejects(bootstrapHcSecureStagingDb({
  environment:{...env(),RAILWAY_PROJECT_ID:'wrong'},
  createClient:()=>{created=true;throw Error('unsafe client created');}
 }),/refused/);
 assert.equal(created,false);
});
test('existing database or privileged roles prevents any CREATE DATABASE command',async()=>{
 for(const hasDatabase of [true,false]){
  let commands=[],closed=false;
  const root={
   connect:async()=>{},
   query:async(sql)=>{
    commands.push(sql);
    if(sql.startsWith('SELECT current_database()'))return {rowCount:1,rows:[{db:'railway',role:'postgres',version:180001}]};
    if(sql.startsWith('SELECT 1 FROM pg_database'))return {rowCount:hasDatabase?1:0,rows:hasDatabase?[{one:1}]:[]};
    if(sql.startsWith('SELECT rolname FROM pg_roles'))return {rowCount:hasDatabase?0:1,rows:hasDatabase?[]:[{rolname:'already-present'}]};
    throw Error('Unexpected SQL');
   },
   end:async()=>{closed=true;}
  };
  await assert.rejects(bootstrapHcSecureStagingDb({
   environment:env(),createClient:()=>root
  }),/refused/);
  assert.equal(commands.some(q=>q.startsWith('CREATE DATABASE')),false);
  assert.equal(closed,true);
 }
});
test('wrong server version or default database blocks before any write',async()=>{
 for(const context of [
  {db:'hc_owner_stage_test',role:'postgres',version:180001},
  {db:'railway',role:'runtime',version:180001},
  {db:'railway',role:'postgres',version:170005},
  {db:'railway',role:'postgres',version:190001}
 ]){
  const queries=[];
  const fake={
   connect:async()=>{},
   query:async sql=>{queries.push(sql);return {rowCount:1,rows:[context]};},
   end:async()=>{}
  };
  await assert.rejects(bootstrapHcSecureStagingDb({
   environment:env(),createClient:()=>fake
  }),/refused/);
  assert.equal(queries.some(q=>q.startsWith('CREATE DATABASE')),false);
 }
});
test('failed after new DB create does not automatically delete or retry the DB',async()=>{
 const commands=[],clients=[];
 const root={
  connect:async()=>{},
  query:async(sql)=>{
   commands.push(sql);
   if(sql.startsWith('SELECT current_database()'))return {rowCount:1,rows:[{db:'railway',role:'postgres',version:180001}]};
   if(sql.startsWith('SELECT 1 FROM pg_database'))return {rowCount:0,rows:[]};
   if(sql.startsWith('SELECT rolname FROM pg_roles'))return {rowCount:0,rows:[]};
   if(sql.startsWith('CREATE DATABASE'))return {};
   throw Error('unexpected root command');
  },
  end:async()=>{}
 };
 const target={connect:async()=>{throw Error('new DB unavailable');},end:async()=>{}};
 await assert.rejects(bootstrapHcSecureStagingDb({
  environment:env(),createClient:()=>{const c=clients.length?target:root;clients.push(c);return c;}
 }),/incomplete/);
 assert.equal(commands.filter(x=>x.startsWith('CREATE DATABASE')).length,1);
 assert.equal(commands.some(x=>/DROP DATABASE|DROP ROLE|DELETE FROM/i.test(x)),false);
});

test('successful bootstrap binds each ANY array as one PostgreSQL parameter',async()=>{
 const calls=[];let clients=0;
 const row=x=>({rowCount:1,rows:[x]});
 const groupNames=['hc_owner_stage_runtime_privs','hc_owner_stage_operator_privs'];
 const root={connect:async()=>{},end:async()=>{},query:async(sql,params=[])=>{
  calls.push(sql);
  if(sql.startsWith('SELECT current_database()'))return row({db:'railway',role:'postgres',version:180001});
  if(sql.startsWith('SELECT 1 FROM pg_database'))return {rowCount:0,rows:[]};
  if(sql.includes('ANY($1::text[])')){
   assert.deepEqual(params,[[...groupNames,'hc_owner_stage_runtime','hc_owner_stage_operator']]);
   return {rowCount:0,rows:[]};
  }
  if(sql.startsWith('CREATE DATABASE'))return {};
  throw Error('unexpected root SQL');
 }};
 const target={connect:async()=>{},end:async()=>{},query:async(sql,params=[])=>{
  calls.push(sql);
  if(sql.startsWith('SELECT to_regclass'))return row(Object.fromEntries(Array.from({length:9},(_,i)=>['t'+i,true])));
  if(sql.includes('ANY($1::text[])')){
   assert.deepEqual(params,[groupNames]);
   return {rowCount:2,rows:groupNames.map(rolname=>({rolname,rolcanlogin:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false}))};
  }
  if(sql.startsWith('SELECT has_table_privilege'))return row({issue:false,remove:false,digest:false,employee:false,expiry:false,consume:true,credential:true,operator_issue:true,operator_totp:false});
  if(sql.startsWith('SELECT (SELECT COUNT(*)'))return row({owners:0,activations:0});
  return {};
 }};
 const result=await bootstrapHcSecureStagingDb({environment:env(),createClient:()=>clients++?target:root,
  loadFixture:async name=>name==='db/hc_owner_staging_privilege_groups.sql'?'BEGIN;\nSELECT 1;\nCOMMIT;':'SELECT 1;'});
 assert.equal(result.schemaCreated,true);
 assert.equal(calls.filter(x=>x.startsWith('CREATE DATABASE')).length,1);
 assert.ok(calls.includes('COMMIT'));
 assert.equal(calls.includes('ROLLBACK'),false);
});
