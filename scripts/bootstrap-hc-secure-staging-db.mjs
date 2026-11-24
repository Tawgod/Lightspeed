#!/usr/bin/env node
// HC Secure: NEW private Railway staging PG18 ONLY, one-time operator service.
// NOT a public auth endpoint. No copied Owner data, tokens, activation,
// credentials, secrets, or unattended migration. Never run in original Owner
// Railway project; root database connection is isolated and narrowly pinned.
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {OWNER_STAGE_FIXTURES} from './bootstrap-owner-stage-database.mjs';
import {stripFixtureTransaction} from './test-hc-secure-schema-disposable.mjs';

const PROJECT='120de974-f2e8-46be-9a00-8eb8b1be4cc4';
const ENVIRONMENT='8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c';
const SERVICE='hc-secure-db-bootstrap-once';
const HOST='hc-secure-postgres-staging.railway.internal';
const DATABASE='hc_owner_stage_test';
const EXPECTED_TABLES=Object.freeze([
 'hc_admin_principals','hc_staff_passkeys','hc_staff_passkey_challenges',
 'hc_staff_passkey_events','hc_staff_auth_throttle','hc_staff_factor_approvals',
 'hc_staff_totp','hc_first_owner_activations','hc_first_owner_activation_events'
]);
const GROUPS=['hc_owner_stage_runtime_privs','hc_owner_stage_operator_privs'];
const LOGINS=['hc_owner_stage_runtime','hc_owner_stage_operator'];
const fail=()=>new Error('HC Secure dedicated staging database bootstrap refused.');
export function checkHcSecureBootstrapScope(e={}){
 if(e.RAILWAY_PROJECT_ID!==PROJECT ||e.RAILWAY_ENVIRONMENT_ID!==ENVIRONMENT||
    e.RAILWAY_SERVICE_NAME!==SERVICE||
    e.HC_SECURE_DB_BOOTSTRAP_ONLY!=='true'||
    e.HC_SECURE_DB_MUTATION_APPROVED!=='HC_SECURE_FRESH_DB_SCHEMA_ONLY'||
    e.HC_OWNER_STAGING_ENABLED==='true'||e.OWNER_STAGING_IDENTITY_ENABLED==='true'||
    e.HC_STAGING_TEST_LOGIN_ENABLED==='true'||e.HC_STAGING_PIN_SETUP_ENABLED==='true'||
    ['DATABASE_URL','HC_OWNER_STAGING_DATABASE_URL','HC_OWNER_TIMECLOCK_SERVICE_SECRET',
     'OWNER_STAGING_SERVICE_SECRET','LIGHTSPEED_TOKEN','DISCORD_TOKEN',
     'TIMECLOCK_ADMIN_SECRET','HC_OWNER_DB_RUNTIME_PASSWORD',
     'HC_OWNER_DB_OPERATOR_PASSWORD'].some(k=>e[k]))throw fail();
 let url;
 try{url=new URL(e.HC_SECURE_BOOTSTRAP_ROOT_URL);}catch{throw fail();}
 if(!['postgres:','postgresql:'].includes(url.protocol)||
    url.hostname!==HOST||url.pathname!=='/railway'||
    url.username!=='postgres'||!url.password||url.password.length<16||
    url.search||url.hash)throw fail();
 return url;
}
async function verifyPristineRoot(root){
 const info=await root.query(
  "SELECT current_database() AS db,current_user AS role,"+
  "current_setting('server_version_num')::integer AS version"
 );
 const x=info.rows?.[0];
 if(info.rowCount!==1||x?.db!=='railway'||x?.role!=='postgres'||
    x?.version<180000||x?.version>=190000)throw fail();
 const db=await root.query('SELECT 1 FROM pg_database WHERE datname=$1',[DATABASE]);
 if(db.rowCount!==0)throw fail(); // Never rerun on existing database.
 const roles=await root.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[...GROUPS,...LOGINS]);
 if(roles.rowCount!==0)throw fail(); // Never overwrite any existing role.
}
async function checkRestrictedGroups(client){
 const t=await client.query('SELECT '+
  EXPECTED_TABLES.map((_,i)=>'to_regclass($'+(i+1)+'::text) IS NOT NULL AS t'+i).join(', '),
  [...EXPECTED_TABLES]);
 if(t.rowCount!==1||EXPECTED_TABLES.some((_,i)=>t.rows[0]['t'+i]!==true))throw fail();
 const r=await client.query(
  'SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles '+
  'WHERE rolname=ANY($1::text[])',[...GROUPS]);
 if(r.rowCount!==2||r.rows.some(x=>x.rolcanlogin||x.rolsuper||x.rolcreatedb||x.rolcreaterole))throw fail();
 const p=await client.query(
  "SELECT "+
  "has_table_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','INSERT') AS issue,"+
  "has_table_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','DELETE') AS remove,"+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','activation_digest','UPDATE') AS digest,"+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','employee_id','UPDATE') AS employee,"+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','expires_at','UPDATE') AS expiry,"+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','consumed_at','UPDATE') AS consume,"+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','credential_id','UPDATE') AS credential,"+
  "has_table_privilege('hc_owner_stage_operator_privs','hc_first_owner_activations','INSERT') AS operator_issue,"+
  "has_table_privilege('hc_owner_stage_operator_privs','hc_staff_totp','SELECT') AS operator_totp"
 );
 const a=p.rows?.[0];
 if(p.rowCount!==1||!a||a.issue!==false||a.remove!==false||
    a.digest!==false||a.employee!==false||a.expiry!==false||
    a.consume!==true||a.credential!==true||a.operator_issue!==true||
    a.operator_totp!==false)throw fail();
 const counts=await client.query(
  'SELECT (SELECT COUNT(*) FROM hc_admin_principals)::integer AS owners,'+
  '(SELECT COUNT(*) FROM hc_first_owner_activations)::integer AS activations'
 );
 if(counts.rows?.[0]?.owners!==0||counts.rows?.[0]?.activations!==0)throw fail();
}
export async function bootstrapHcSecureStagingDb({
 environment=process.env,
 createClient=opts=>new pg.Client(opts),
 loadFixture=path=>readFile(new URL('../'+path,import.meta.url),'utf8')
}={}){
 const url=checkHcSecureBootstrapScope(environment);
 const root=createClient({connectionString:url.toString(),connectionTimeoutMillis:8000});
 let target;let created=false;
 try{
  await root.connect();
  await verifyPristineRoot(root);
  await root.query('CREATE DATABASE '+DATABASE);
  created=true;
  const targetUrl=new URL(url);targetUrl.pathname='/'+DATABASE;
  target=createClient({connectionString:targetUrl.toString(),connectionTimeoutMillis:8000});
  await target.connect();
  await target.query('BEGIN');
  try{
   await target.query("SET LOCAL statement_timeout='40s'");
   await target.query("SET LOCAL lock_timeout='3s'");
   for(const path of OWNER_STAGE_FIXTURES)
    await target.query(stripFixtureTransaction(path,await loadFixture(path)));
   await target.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
   await target.query('REVOKE ALL ON DATABASE '+DATABASE+' FROM PUBLIC');
   await target.query('GRANT CONNECT ON DATABASE '+DATABASE+
    ' TO hc_owner_stage_runtime_privs,hc_owner_stage_operator_privs');
   await checkRestrictedGroups(target);
   await target.query('COMMIT');
  }catch(e){
   await target.query('ROLLBACK').catch(()=>{});
   throw e;
  }
  return Object.freeze({schemaCreated:true,tables:EXPECTED_TABLES.length,
   groups:GROUPS.length,lockedLoginsNotYetProvisioned:true,ownerActivations:0});
 }catch(e){
  // CREATE DATABASE cannot be rolled back. Leave failed/partly initialized
  // DB intact for operator inspection; NEVER drop, overwrite or retry blindly.
  if(created)throw new Error('HC Secure DB bootstrap incomplete: review new isolated database; do not retry automatically.');
  throw fail();
 }finally{
  await target?.end().catch(()=>{});
  await root.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 try{
  const r=await bootstrapHcSecureStagingDb();
  console.log('HC_SECURE_SCHEMA_BOOTSTRAP_OK tables='+r.tables+
   ' nonlogin_groups='+r.groups+' no_logins=true activations=0');
 }catch{
  console.error('HC_SECURE_SCHEMA_BOOTSTRAP_BLOCKED');
  process.exitCode=1;
 }
}
