import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runAdminSchemaMigration,validateAdminMigrationTarget} from '../scripts/admin-schema-isolated-once.mjs';

const environment={
 HC_ADMIN_SCHEMA_MIGRATION_ENABLED:'true',
 HC_ADMIN_SCHEMA_MIGRATION_TARGET:'Postgres-O39p',
 HC_ADMIN_SCHEMA_MIGRATION_ENVIRONMENT:'test',
 HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_HOST:'postgres-o39p.railway.internal',
 HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_DB:'railway',
 HC_ADMIN_SCHEMA_DATABASE_URL:'postgresql://generated:secret@postgres-o39p.railway.internal:5432/railway'
};
test('isolated migration refuses all missing, wrong or unsafe targets before DB connection',()=>{
 assert.deepEqual(validateAdminMigrationTarget(environment),{
  host:'postgres-o39p.railway.internal',database:'railway'
 });
 for(const change of [
  {HC_ADMIN_SCHEMA_MIGRATION_ENABLED:'false'},
  {HC_ADMIN_SCHEMA_MIGRATION_TARGET:'Postgres'},
  {HC_ADMIN_SCHEMA_MIGRATION_ENVIRONMENT:'production'},
  {HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_HOST:'real-db.example.net'},
  {HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_DB:'other'},
  {HC_ADMIN_SCHEMA_DATABASE_URL:'postgresql://generated:secret@postgres.railway.internal:5432/railway'},
  {HC_ADMIN_SCHEMA_DATABASE_URL:'postgresql://generated:secret@postgres-o39p.railway.internal:5432/production'},
  {HC_ADMIN_SCHEMA_DATABASE_URL:'http://user:pass@postgres-o39p.railway.internal/railway'},
  {HC_ADMIN_SCHEMA_DATABASE_URL:''}
 ])assert.throws(()=>validateAdminMigrationTarget({...environment,...change}),/refused/);
});
function mockPool({existing=false,populated=false,incomplete=false,badIdentity=false,failMigration=false}={}){
 const queries=[],calls=[];
 const client={
  async query(sql,params){
   queries.push({sql,params});
   if(failMigration&&sql.includes('CREATE TABLE IF NOT EXISTS'))throw Error('DDL test failure');
   if(sql.includes('current_database()'))return {rowCount:1,rows:[{database:badIdentity?'production':'railway',username:'test_owner'}]};
   if(sql.includes('to_regclass('))return {rows:[{relation:existing?'hc_admin_principals':null}]};
   if(sql.includes('count(*)::integer AS n FROM public.hc_admin_principals'))return {rows:[{n:populated?1:0}]};
   if(sql.includes('information_schema.tables'))return {rows:[{n:incomplete?5:6}]};
   if(sql.includes('AS principals'))return {rows:[{principals:populated?1:0,grants:0}]};
   return {rows:[],rowCount:0};
  },
  release(){calls.push('release')}
 };
 return {queries,calls,poolFactory:()=>({
  connect:async()=>client,
  end:async()=>{calls.push('end')}
 })};
}
test('migration locks, runs only canonical schema, verifies empty grants and commits',async()=>{
 const m=mockPool();
 const schema=await readFile(new URL('../db/hc_admin_delegations.sql',import.meta.url),'utf8');
 const result=await runAdminSchemaMigration({
  env:environment,poolFactory:m.poolFactory,loadSql:async()=>schema
 });
 assert.equal(result.schemaReady,true);
 assert.equal(result.principals,0);
 assert.equal(result.grants,0);
 const sql=m.queries.map(x=>x.sql);
 assert.equal(sql[0],'BEGIN');
 assert.ok(sql.some(x=>x.includes('pg_advisory_xact_lock')));
 assert.ok(sql.includes(schema),'must apply canonical schema, not fixture');
 assert.equal(sql.at(-1),'COMMIT');
 assert.ok(!sql.some(x=>/INSERT INTO\s+hc_admin_principals|ALTER ROLE.*LOGIN/i.test(x)));
 assert.deepEqual(m.calls,['release','end']);
});
test('preexisting admin identity or schema errors roll back and never commit',async()=>{
 for(const scenario of [
  {existing:true,populated:true},{incomplete:true},{badIdentity:true},{failMigration:true}
 ]){
  const m=mockPool(scenario);
  await assert.rejects(runAdminSchemaMigration({
   env:environment,poolFactory:m.poolFactory,loadSql:async()=>
    'CREATE TABLE IF NOT EXISTS hc_admin_principals(id integer)'
  }));
  assert.equal(m.queries.map(x=>x.sql).includes('COMMIT'),false);
  assert.ok(m.queries.map(x=>x.sql).includes('ROLLBACK'));
  assert.deepEqual(m.calls,['release','end']);
 }
});
