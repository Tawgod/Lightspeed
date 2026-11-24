// HC Secure private, read-only readiness service. No login routes or migrations.
import express from 'express';
import pg from 'pg';
import {verifyOwnerStagingDatabasePrivileges} from '../services/security/ownerStagingDatabasePreflight.js';
const fail=()=>new Error('HC Secure runtime readiness refused.');
export function validateRuntimeScope(e={}){
 if(e.RAILWAY_PROJECT_ID!=='120de974-f2e8-46be-9a00-8eb8b1be4cc4'||
 e.RAILWAY_ENVIRONMENT_ID!=='8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c'||
 e.RAILWAY_SERVICE_NAME!=='hc-secure-auth-staging'||
 e.HC_SECURE_RUNTIME_READINESS_ONLY!=='true'||
 e.HC_OWNER_STAGING_ENABLED!=='false'||
 e.HC_STAGING_TEST_LOGIN_ENABLED!=='false'||e.HC_STAGING_PIN_SETUP_ENABLED!=='false'||
 ['DATABASE_URL','HC_SECURE_BOOTSTRAP_ROOT_URL','HC_SECURE_DB_OPERATOR_PASSWORD','HC_OWNER_OPERATOR_DATABASE_URL','HC_OWNER_TIMECLOCK_SERVICE_SECRET','HC_SECURE_DB_RUNTIME_PASSWORD','HC_OWNER_DB_OPERATOR_PASSWORD','HC_OWNER_DB_RUNTIME_PASSWORD'].some(k=>e[k])||
 ['HC_SECURE_DB_BOOTSTRAP_ONLY','HC_SECURE_ROLE_PREPARE_ONLY','HC_SECURE_CREDENTIAL_COMMISSION_ONLY'].some(k=>e[k]&&e[k]!=='false'))throw fail();
 let u;try{u=new URL(e.HC_OWNER_STAGING_DATABASE_URL);}catch{throw fail();}
 if(u.protocol!=='postgresql:'||u.hostname!=='hc-secure-postgres-staging.railway.internal'||u.port!=='5432'||u.pathname!=='/hc_owner_stage_test'||u.username!=='hc_owner_stage_runtime'||!/^[A-Za-z0-9]{48}$/.test(u.password)||u.search||u.hash)throw fail();
 return u.toString();
}
export async function checkRuntime({environment=process.env,createClient=o=>new pg.Client(o)}={}){
 const connectionString=validateRuntimeScope(environment);
 const c=createClient({connectionString,connectionTimeoutMillis:6000});
 try{
  await c.connect();
  await c.query('BEGIN READ ONLY');
  await c.query("SET LOCAL statement_timeout='5s'");
  const r=await c.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::integer AS version,current_setting('transaction_read_only') AS ro,pg_has_role(current_user,'hc_owner_stage_runtime_privs','MEMBER') AS runtime,pg_has_role(current_user,'hc_owner_stage_operator_privs','MEMBER') AS operator,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  const x=r.rows?.[0];
  if(r.rowCount!==1||x?.db!=='hc_owner_stage_test'||x?.role!=='hc_owner_stage_runtime'||!(x?.version>=180000&&x?.version<190000)||x?.ro!=='on'||x?.runtime!==true||x?.operator!==false||['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some(k=>x[k]!==false))throw fail();
  await verifyOwnerStagingDatabasePrivileges({pool:{connect:async()=>({query:(...args)=>c.query(...args),release:()=>{}})}});
  await c.query('ROLLBACK');
  return true;
 }catch{await c.query('ROLLBACK').catch(()=>{});throw fail();}
 finally{await c.end().catch(()=>{});}
}
export async function startReadiness(environment=process.env){
 const port=Number(environment.PORT);
 if(!Number.isInteger(port)||port<1||port>65535)throw fail();
 await checkRuntime({environment});
 const app=express();app.disable('x-powered-by');
 app.get('/health',(_req,res)=>res.set('Cache-Control','no-store').json({ready:true,mode:'private-readiness'}));
 return app.listen(port,'0.0.0.0',()=>console.log('HC_SECURE_RUNTIME_READINESS_OK read_only=true restricted_runtime=true login_routes=false'));
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 startReadiness().catch(()=>{console.error('HC_SECURE_RUNTIME_READINESS_BLOCKED');process.exitCode=1;});
}
