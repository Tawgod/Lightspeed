import test from 'node:test';
import assert from 'node:assert/strict';
import {checkHcSecureLockedRoleScope,prepareHcSecureLockedRoles}
 from '../scripts/prepare-hc-secure-locked-roles.mjs';
const env=()=>({
 RAILWAY_PROJECT_ID:'120de974-f2e8-46be-9a00-8eb8b1be4cc4',
 RAILWAY_ENVIRONMENT_ID:'8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c',
 RAILWAY_SERVICE_NAME:'hc-secure-db-bootstrap-once',
 HC_SECURE_DB_BOOTSTRAP_ONLY:'false',
 HC_SECURE_CREDENTIAL_COMMISSION_ONLY:'false',
 HC_SECURE_DB_MUTATION_APPROVED:'HC_SECURE_LOCKED_ROLES_ONLY',
 HC_SECURE_ROLE_PREPARE_ONLY:'true',
 HC_SECURE_BOOTSTRAP_ROOT_URL:
  'postgresql://postgres:fixture-only-password-123456@hc-secure-postgres-staging.railway.internal:5432/railway'
});
test('only independently acknowledged HC Secure role preparation allowed',()=>{
 const target=checkHcSecureLockedRoleScope(env());
 assert.equal(target.pathname,'/railway');
});
test('wrong scope, credential exposure and old project refuse before connection',async()=>{
 const variants=[
  {RAILWAY_PROJECT_ID:'5b46096d-3178-47ec-ba88-d5037696346a'},
  {RAILWAY_ENVIRONMENT_ID:'46b93c76-3085-4e76-a37d-90dfdd250dd2'},
  {HC_SECURE_ROLE_PREPARE_ONLY:'false'},
  {HC_SECURE_DB_BOOTSTRAP_ONLY:'true'},
  {HC_SECURE_CREDENTIAL_COMMISSION_ONLY:'true'},
  {HC_SECURE_DB_MUTATION_APPROVED:'HC_SECURE_FRESH_DB_SCHEMA_ONLY'},
  {HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'1'},
  {HC_OWNER_DB_RUNTIME_PASSWORD:'forbidden'},
  {HC_OWNER_STAGING_DATABASE_URL:'postgres://forbidden'},
  {HC_OWNER_OPERATOR_DATABASE_URL:'postgres://forbidden'},
  {RAILWAY_SERVICE_NAME:'hc-secure-auth-staging'}
 ];
 for(const v of variants){
  let called=false;
  await assert.rejects(prepareHcSecureLockedRoles({
   environment:{...env(),...v},createClient:()=>{called=true;throw Error('unsafe');}
  }),/refused/);
  assert.equal(called,false);
 }
});
test('unexpected current database, runtime user, PG version refuses before creating roles',async()=>{
 for(const c of [
  {db:'railway',role:'postgres',version:180002},
  {db:'hc_owner_stage_test',role:'hc_owner_stage_runtime',version:180002},
  {db:'hc_owner_stage_test',role:'postgres',version:170012}
 ]){
  const sql=[];
  const client={
   connect:async()=>{},
   query:async q=>{
    sql.push(q);
    if(q.startsWith('SELECT current_database()'))return {rowCount:1,rows:[c]};
    return {rowCount:0,rows:[]};
   },
   end:async()=>{}
  };
  await assert.rejects(prepareHcSecureLockedRoles({
   environment:env(),createClient:()=>client
  }),/refused/);
  assert.equal(sql.some(q=>q.startsWith('CREATE ROLE')),false);
  assert.ok(sql.includes('ROLLBACK'));
 }
});
test('an already existing login role refuses before any CREATE ROLE',async()=>{
 const sql=[];
 const c={
  connect:async()=>{},
  query:async q=>{
   sql.push(q);
   if(q.startsWith('SELECT current_database()'))return {rowCount:1,rows:[{db:'hc_owner_stage_test',role:'postgres',version:180002}]};
   if(q.startsWith('SELECT (SELECT COUNT(*)'))return {rowCount:1,rows:[{owners:0,activations:0}]};
   if(q.startsWith('SELECT rolname FROM pg_roles'))return {rowCount:1,rows:[{rolname:'hc_owner_stage_runtime'}]};
   return {rowCount:0,rows:[]};
  },
  end:async()=>{}
 };
 await assert.rejects(prepareHcSecureLockedRoles({environment:env(),createClient:()=>c}),/refused/);
 assert.equal(sql.some(q=>q.startsWith('CREATE ROLE')),false);
 assert.ok(sql.includes('ROLLBACK'));
});
test('existing Owner or activation prevents role creation',async()=>{
 const sql=[];
 const c={
  connect:async()=>{},query:async q=>{
   sql.push(q);
   if(q.startsWith('SELECT current_database()'))return {rowCount:1,rows:[{db:'hc_owner_stage_test',role:'postgres',version:180001}]};
   if(q.startsWith('SELECT (SELECT COUNT(*)'))return {rowCount:1,rows:[{owners:1,activations:0}]};
   return {};
  },end:async()=>{}
 };
 await assert.rejects(prepareHcSecureLockedRoles({environment:env(),createClient:()=>c}),/refused/);
 assert.equal(sql.some(q=>q.startsWith('CREATE ROLE')),false);
});

test('role preparation does not arm schema or credential mutation flags',()=>{
 const e=env();checkHcSecureLockedRoleScope(e);
 assert.equal(e.HC_SECURE_DB_BOOTSTRAP_ONLY,'false');
 assert.equal(e.HC_SECURE_CREDENTIAL_COMMISSION_ONLY,'false');
 assert.equal(e.HC_SECURE_DB_MUTATION_APPROVED,'HC_SECURE_LOCKED_ROLES_ONLY');
});
