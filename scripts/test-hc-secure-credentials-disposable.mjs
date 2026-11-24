#!/usr/bin/env node
// Real PostgreSQL 18 integration test: local disposable container only.
// Uses a synthetic HC Secure scope plus an injected local connection adapter.
// Never connects to Railway; no real Owner data, passwords or credentials.
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {OWNER_STAGE_FIXTURES} from './bootstrap-owner-stage-database.mjs';
import {stripFixtureTransaction} from './test-hc-secure-schema-disposable.mjs';
import {commissionHcSecureCredentials} from './commission-hc-secure-db-credentials.mjs';

const fail=()=>new Error('Disposable HC Secure credential test blocked.');
const testPort='15489';
function requireLocalConfig(e=process.env){
 if(e.HC_SECURE_DISPOSABLE_CREDENTIAL_TEST!=='true'||
    e.RAILWAY_PROJECT_ID||e.RAILWAY_ENVIRONMENT_ID||e.RAILWAY_SERVICE_ID||
    e.HC_OWNER_STAGING_DATABASE_URL||e.DATABASE_URL)throw fail();
 let url;
 try{url=new URL(e.HC_SECURE_DISPOSABLE_DATABASE_URL);}catch{throw fail();}
 if(!['postgresql:','postgres:'].includes(url.protocol)||
    url.hostname!=='127.0.0.1'||url.port!==testPort||
    url.pathname!=='/hc_owner_stage_test'||url.username!=='postgres'||
    !/^[A-Za-z0-9]{48}$/.test(url.password)||url.hash||url.search)throw fail();
 return url;
}
function envForSyntheticScope(local,e){
 const password=e.HC_SECURE_DISPOSABLE_DATABASE_URL?local.password:null;
 if(!password)throw fail();
 return {
  RAILWAY_PROJECT_ID:'120de974-f2e8-46be-9a00-8eb8b1be4cc4',
  RAILWAY_ENVIRONMENT_ID:'8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c',
  RAILWAY_SERVICE_NAME:'hc-secure-db-bootstrap-once',
  HC_SECURE_CREDENTIAL_COMMISSION_ONLY:'true',
  HC_SECURE_DB_MUTATION_APPROVED:'HC_SECURE_CREDENTIALS_ONLY',
  HC_SECURE_BOOTSTRAP_ROOT_URL:
   'postgresql://postgres:'+password+'@hc-secure-postgres-staging.railway.internal:5432/railway',
  HC_SECURE_DB_RUNTIME_PASSWORD:'B'.repeat(48),
  HC_SECURE_DB_OPERATOR_PASSWORD:'C'.repeat(48)
 };
}
function adapter(local,{failOperator=false}={}){
 let operatorFailurePending=failOperator;
 const change=opts=>{
  const u=new URL(opts.connectionString);
  if(u.hostname!=='hc-secure-postgres-staging.railway.internal')throw fail();
  const mapped=new URL(local);
  mapped.pathname=u.pathname;
  mapped.username=u.username;
  mapped.password=u.password;
  return {...opts,connectionString:mapped.toString()};
 };
 return {
  createClient:opts=>{
   const mapped=change(opts);
   const client=new pg.Client(mapped);
   if(failOperator&&new URL(opts.connectionString).username==='hc_owner_stage_operator'&&operatorFailurePending){
    operatorFailurePending=false;
    return {connect:async()=>{throw Error('Injected postcommit operator verification failure');},
     end:async()=>{}};
   }
   return client;
  },
  createPool:opts=>new pg.Pool(change(opts))
 };
}
async function roleLockState(root){
 const r=await root.query("SELECT rolname,rolpassword IS NULL AS locked FROM pg_authid WHERE rolname=ANY($1::text[])",
  [['hc_owner_stage_runtime','hc_owner_stage_operator']]);
 assert.equal(r.rowCount,2);
 return r.rows.every(x=>x.locked===true);
}
async function main(){
 const local=requireLocalConfig();
 const root=new pg.Client({connectionString:local.toString(),connectionTimeoutMillis:7000});
 await root.connect();
 try{
  const ctx=await root.query("SELECT current_user AS role,current_database() AS db,"+
   "current_setting('server_version_num')::integer AS version,"+
   "current_setting('cluster_name') AS cluster");
  const c=ctx.rows?.[0];
  if(c?.role!=='postgres'||c?.db!=='hc_owner_stage_test'||
     c?.version<180000||c?.version>=190000||
     c?.cluster!=='hc-secure-credentials-disposable-pg18')throw fail();
  const names=['hc_admin_principals','hc_first_owner_activations'];
  const existing=await root.query('SELECT '+
   names.map((_,i)=>'to_regclass($'+(i+1)+'::text) IS NOT NULL AS t'+i).join(', '),names);
  if(existing.rows?.[0]?.t0!==false||existing.rows?.[0]?.t1!==false)throw fail();
  const presentRoles=await root.query("SELECT count(*)::integer AS count FROM pg_roles WHERE rolname=ANY($1::text[])",
   [['hc_owner_stage_runtime','hc_owner_stage_operator','hc_owner_stage_runtime_privs','hc_owner_stage_operator_privs']]);
  if(presentRoles.rows?.[0]?.count!==0)throw fail();

  // The seven already-reviewed SQL fixtures and separate PASSWORD NULL logins.
  await root.query('BEGIN');
  try{
   for(const path of OWNER_STAGE_FIXTURES){
    const contents=await readFile(new URL('../'+path,import.meta.url),'utf8');
    await root.query(stripFixtureTransaction(path,contents));
   }
   await root.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
   await root.query("CREATE ROLE hc_owner_stage_runtime LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT");
   await root.query("CREATE ROLE hc_owner_stage_operator LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT");
   await root.query('GRANT hc_owner_stage_runtime_privs TO hc_owner_stage_runtime');
   await root.query('GRANT hc_owner_stage_operator_privs TO hc_owner_stage_operator');
   await root.query('COMMIT');
  }catch(e){await root.query('ROLLBACK').catch(()=>{});throw e;}
  assert.equal(await roleLockState(root),true);

  const synthetic=envForSyntheticScope(local,process.env);
  // First, inject an error after password commit and verify automatic re-lock.
  await assert.rejects(commissionHcSecureCredentials({
   environment:synthetic,...adapter(local,{failOperator:true})
  }),/blocked/);
  assert.equal(await roleLockState(root),true,
   'both role passwords must be locked after failed postcommit verification');

  // Then perform the complete success path against real PG18 auth.
  const result=await commissionHcSecureCredentials({
   environment:synthetic,...adapter(local)
  });
  assert.deepEqual(result,{
   runtimeVerified:true,operatorVerified:true,badPasswordDenied:true,activations:0
  });
  assert.equal(await roleLockState(root),false);
  const count=await root.query("SELECT (SELECT count(*)::integer FROM hc_admin_principals) AS owners,"+
   "(SELECT count(*)::integer FROM hc_first_owner_activations) AS activations");
  assert.equal(count.rows?.[0]?.owners,0);
  assert.equal(count.rows?.[0]?.activations,0);
  // No persistent credentials remain in the disposable DB after the test.
  await root.query('BEGIN');
  try{
   await root.query('ALTER ROLE hc_owner_stage_runtime PASSWORD NULL');
   await root.query('ALTER ROLE hc_owner_stage_operator PASSWORD NULL');
   await root.query('COMMIT');
  }catch(e){await root.query('ROLLBACK').catch(()=>{});throw e;}
  assert.equal(await roleLockState(root),true);
  console.log('HC_SECURE_DISPOSABLE_CREDENTIALS_OK postcommit_relock=true scram_logins=true bad_password_denied=true final_roles_locked=true owner_activations=0');
 }finally{await root.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 main().catch(()=>{console.error('HC_SECURE_DISPOSABLE_CREDENTIALS_BLOCKED');process.exitCode=1;});
}
