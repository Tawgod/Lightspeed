#!/usr/bin/env node
// Read-only pre-bootstrap inspection for the new HC Secure private PG18 cluster.
import pg from 'pg';
import {pathToFileURL} from 'node:url';
const fail=()=>new Error('HC Secure root readiness blocked');
export function validateRootReadiness(e){
 if(e.RAILWAY_PROJECT_ID!=='120de974-f2e8-46be-9a00-8eb8b1be4cc4' ||
 e.RAILWAY_ENVIRONMENT_ID!=='8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c' ||
 e.RAILWAY_SERVICE_NAME!=='hc-secure-db-bootstrap-once' ||
 e.HC_SECURE_DB_MUTATION_APPROVED!=='DISABLED' ||
 ['HC_SECURE_DB_BOOTSTRAP_ONLY','HC_SECURE_ROLE_PREPARE_ONLY','HC_SECURE_CREDENTIAL_COMMISSION_ONLY','HC_OWNER_STAGING_ENABLED','HC_STAGING_TEST_LOGIN_ENABLED','HC_STAGING_PIN_SETUP_ENABLED'].some(k=>e[k]!=='false') ||
 ['DATABASE_URL','HC_OWNER_STAGING_DATABASE_URL','HC_OWNER_OPERATOR_DATABASE_URL','HC_OWNER_TIMECLOCK_SERVICE_SECRET','HC_SECURE_DB_RUNTIME_PASSWORD','HC_SECURE_DB_OPERATOR_PASSWORD'].some(k=>e[k]))throw fail();
 let u;try{u=new URL(e.HC_SECURE_BOOTSTRAP_ROOT_URL)}catch{throw fail()}
 if(!['postgres:','postgresql:'].includes(u.protocol)||u.hostname!=='hc-secure-postgres-staging.railway.internal'||(u.port&&u.port!=='5432')||u.pathname!=='/railway'||u.username!=='postgres'||! /^[A-Za-z0-9]{48}$/.test(u.password)||u.search||u.hash)throw fail();
 return u.toString();
}
export async function inspectRoot({environment=process.env,createClient=o=>new pg.Client(o)}={}){
 const url=validateRootReadiness(environment);
 const c=createClient({connectionString:url,connectionTimeoutMillis:8000,statement_timeout:5000,application_name:'hc-secure-root-read-only'});
 try{
  await c.connect();
  await c.query('BEGIN READ ONLY');
  const r=await c.query(`SELECT current_database()='railway' AS db_ok,current_user='postgres' AS role_ok,
  current_setting('server_version_num')::integer BETWEEN 180000 AND 189999 AS version_ok,
  current_setting('transaction_read_only')='on' AS read_only,
  NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='hc_owner_stage_test') AS target_absent,
  NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname LIKE 'hc_owner_stage_%') AS roles_absent,
  NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' AND c.relkind IN ('r','p','v','m','f','S')) AS root_empty`);
  const keys=['db_ok','role_ok','version_ok','read_only','target_absent','roles_absent','root_empty'];
  if(r.rowCount!==1||keys.some(k=>r.rows?.[0]?.[k]!==true))throw fail();
  await c.query('ROLLBACK');
  return {ready:true,readOnly:true,targetAbsent:true,rolesAbsent:true,rootEmpty:true};
 }catch{try{await c.query('ROLLBACK')}catch{}throw fail()}
 finally{await c.end().catch(()=>{})}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{await inspectRoot();console.log('HC_SECURE_ROOT_READY=true read_only=true target_absent=true roles_absent=true root_empty=true')}
 catch{console.error('HC_SECURE_ROOT_READY_BLOCKED');process.exitCode=1}
}
