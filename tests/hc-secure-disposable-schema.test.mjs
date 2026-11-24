import test from 'node:test';
import assert from 'node:assert/strict';
import {
 verifyDisposableTarget,stripFixtureTransaction,testHcSecureDisposableSchema
} from '../scripts/test-hc-secure-schema-disposable.mjs';

const good=()=>({
 HC_SECURE_DISPOSABLE_SCHEMA_TEST:'true',
 HC_SECURE_DISPOSABLE_DATABASE_URL:
  'postgresql://postgres:example-only@127.0.0.1:15488/hc_owner_stage_test'
});
test('strict local-only disposable target is accepted',()=>{
 const url=verifyDisposableTarget(good());
 assert.equal(url.hostname,'127.0.0.1');
 assert.equal(url.port,'15488');
});
test('Railway, original Owner DB, remote endpoints and wrong DB are forbidden',()=>{
 const cases=[
  {RAILWAY_PROJECT_ID:'120de974-f2e8-46be-9a00-8eb8b1be4cc4'},
  {RAILWAY_ENVIRONMENT_ID:'8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c'},
  {RAILWAY_SERVICE_ID:'x'},
  {HC_OWNER_STAGING_ENABLED:'true'},
  {HC_SECURE_DISPOSABLE_SCHEMA_TEST:'false'},
  {HC_SECURE_DISPOSABLE_DATABASE_URL:'postgresql://postgres:test@127.0.0.1:5432/hc_owner_stage_test'},
  {HC_SECURE_DISPOSABLE_DATABASE_URL:'postgresql://postgres:test@localhost:15488/hc_owner_stage_test'},
  {HC_SECURE_DISPOSABLE_DATABASE_URL:'postgresql://postgres:test@127.0.0.1:15488/railway'},
  {HC_SECURE_DISPOSABLE_DATABASE_URL:'postgresql://postgres:test@original.railway.internal:15488/hc_owner_stage_test'},
  {HC_SECURE_DISPOSABLE_DATABASE_URL:'postgresql://postgres:test@127.0.0.1:15488/hc_owner_stage_test?sslmode=disable'}
 ];
 for(const overrides of cases)assert.throws(
  ()=>verifyDisposableTarget({...good(),...overrides}),/refused/);
});
test('privilege fixture transaction boundaries are removed without affecting body',()=>{
 const name='db/hc_owner_staging_privilege_groups.sql';
 const sql='-- reviewed\nBEGIN;\nSELECT 1;\nCOMMIT;\n';
 const out=stripFixtureTransaction(name,sql);
 assert.ok(out.includes('SELECT 1;'));
 assert.ok(!out.includes('BEGIN;'));
 assert.ok(!out.includes('COMMIT;'));
 assert.equal(stripFixtureTransaction('db/hc_staff_totp.sql',sql),sql);
 assert.throws(()=>stripFixtureTransaction(name,'CREATE ROLE anything;'),/refused/);
});
test('invalid target cannot even create a PostgreSQL client',async()=>{
 let called=false;
 await assert.rejects(testHcSecureDisposableSchema({
  environment:{...good(),RAILWAY_PROJECT_ID:'wrong'},
  createClient:()=>{called=true;throw Error('must not be reached');}
 }),/refused/);
 assert.equal(called,false);
});
test('unexpected database cluster/version refuses before any schema fixtures',async()=>{
 let ranFixture=false,closed=false,queries=[];
 const fake={
  connect:async()=>{},
  query:async sql=>{queries.push(sql);return {rowCount:1,rows:[{
   role:'postgres',db:'hc_owner_stage_test',version:180002,cluster:'original-owner'
  }]};},
  end:async()=>{closed=true;}
 };
 await assert.rejects(testHcSecureDisposableSchema({
  environment:good(),createClient:()=>fake,
  loadFixture:async()=>{ranFixture=true;return '';}
 }),/refused/);
 assert.equal(ranFixture,false);
 assert.equal(closed,true);
 assert.equal(queries.some(x=>x==='BEGIN'),false);
});
