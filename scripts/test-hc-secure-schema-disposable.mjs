#!/usr/bin/env node
// Disposable PostgreSQL 18 schema/grants integration test. NEVER RUN ON RAILWAY.
// Uses the exact seven reviewed Owner schema fixtures and ALWAYS ROLLS BACK.
// Does not create an Owner, activation, credential, login role or secret.
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {OWNER_STAGE_FIXTURES} from './bootstrap-owner-stage-database.mjs';
const TABLES=Object.freeze([
 'hc_admin_principals','hc_staff_passkeys','hc_staff_passkey_challenges',
 'hc_staff_passkey_events','hc_staff_auth_throttle','hc_staff_factor_approvals',
 'hc_staff_totp','hc_first_owner_activations','hc_first_owner_activation_events'
]);
const GROUPS=['hc_owner_stage_runtime_privs','hc_owner_stage_operator_privs'];
const PORT='15488', CLUSTER='hc-secure-disposable-pg18';
const refuse=()=>new Error('Disposable PG18 schema test refused.');
export function verifyDisposableTarget(e={}){
 if(e.HC_SECURE_DISPOSABLE_SCHEMA_TEST!=='true' ||
    e.RAILWAY_PROJECT_ID || e.RAILWAY_ENVIRONMENT_ID ||
    e.RAILWAY_SERVICE_ID || e.HC_OWNER_STAGING_ENABLED==='true')throw refuse();
 let u;
 try{u=new URL(e.HC_SECURE_DISPOSABLE_DATABASE_URL);}catch{throw refuse();}
 if(!['postgres:','postgresql:'].includes(u.protocol) ||
    u.hostname!=='127.0.0.1'||u.port!==PORT||
    u.pathname!=='/hc_owner_stage_test'||u.username!=='postgres'||
    !u.password||u.search||u.hash)throw refuse();
 return u;
}
export function stripFixtureTransaction(name,sql){
 if(name!=='db/hc_owner_staging_privilege_groups.sql')return sql;
 // The original privilege fixture wraps itself in BEGIN/COMMIT. Remove
 // ONLY these exact delimiters, so the test owns a single rollback boundary.
 const start=/(^|\n)BEGIN;[ \t]*(?=\r?\n)/g;
 const end=/\r?\nCOMMIT;\s*$/;
 if((sql.match(start)||[]).length!==1||!end.test(sql))throw refuse();
 return sql.replace(start,'\n').replace(end,'\n');
}
export async function testHcSecureDisposableSchema({
 environment=process.env,createClient=opts=>new pg.Client(opts),
 loadFixture=path=>readFile(new URL('../'+path,import.meta.url),'utf8')
}={}){
 const target=verifyDisposableTarget(environment);
 const client=createClient({
  connectionString:target.toString(),
  connectionTimeoutMillis:5000,
  application_name:'hc-secure-disposable-schema-rollback'
 });
 let began=false;
 try{
  await client.connect();
  const context=await client.query(
   "SELECT current_user AS role,current_database() AS db,"+
   "current_setting('server_version_num')::integer AS version,"+
   "current_setting('cluster_name') AS cluster"
  );
  const c=context.rows?.[0];
  if(context.rowCount!==1||c?.role!=='postgres'||
     c?.db!=='hc_owner_stage_test'||c?.version<180000||
     c?.version>=190000||c?.cluster!==CLUSTER)throw refuse();
  const tables=await client.query('SELECT '+
   TABLES.map((_,i)=>'to_regclass($'+(i+1)+'::text) IS NOT NULL AS t'+i).join(', '),TABLES);
  if(tables.rowCount!==1||TABLES.some((_,i)=>tables.rows[0]['t'+i]!==false))
   throw refuse();
  const existing=await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[GROUPS]);
  if(existing.rowCount!==0)throw refuse();

  await client.query('BEGIN');began=true;
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query("SET LOCAL lock_timeout='3s'");
  for(const name of OWNER_STAGE_FIXTURES){
   const sql=stripFixtureTransaction(name,await loadFixture(name));
   await client.query(sql);
  }
  // Reuse the exact Owner staging bootstrap's role/schema names; this
  // integration test deliberately makes no production role modifications.
  const ready=await client.query('SELECT '+
   TABLES.map((_,i)=>'to_regclass($'+(i+1)+'::text) IS NOT NULL AS t'+i).join(', '),TABLES);
  if(ready.rowCount!==1||TABLES.some((_,i)=>ready.rows[0]['t'+i]!==true))
   throw refuse();
  const group=await client.query(
   "SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole "+
   "FROM pg_roles WHERE rolname=ANY($1::text[])",[GROUPS]);
  if(group.rowCount!==2||group.rows.some(x=>
   x.rolcanlogin||x.rolsuper||x.rolcreatedb||x.rolcreaterole))throw refuse();
  const rights=await client.query(
   "SELECT "+
   "has_table_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','INSERT') AS runtime_issue,"+
   "has_table_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','DELETE') AS runtime_delete,"+
   "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','activation_digest','UPDATE') AS runtime_digest,"+
   "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','employee_id','UPDATE') AS runtime_employee,"+
   "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','expires_at','UPDATE') AS runtime_extend,"+
   "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','consumed_at','UPDATE') AS runtime_consume,"+
   "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','credential_id','UPDATE') AS runtime_credential,"+
   "has_table_privilege('hc_owner_stage_operator_privs','hc_first_owner_activations','INSERT') AS operator_issue,"+
   "has_table_privilege('hc_owner_stage_operator_privs','hc_staff_totp','SELECT') AS operator_read_totp"
  );
  const p=rights.rows?.[0];
  if(rights.rowCount!==1||!p||
   p.runtime_issue!==false||p.runtime_delete!==false||
   p.runtime_digest!==false||p.runtime_employee!==false||
   p.runtime_extend!==false||p.runtime_consume!==true||
   p.runtime_credential!==true||p.operator_issue!==true||
   p.operator_read_totp!==false)throw refuse();
  const count=await client.query(
   'SELECT COUNT(*)::integer AS count FROM hc_admin_principals'); // replaced below
  if(count.rows?.[0]?.count!==0)throw refuse();
  return Object.freeze({fixtureCount:OWNER_STAGE_FIXTURES.length,tables:TABLES.length,groups:2,rolledBack:true});
 }finally{
  if(began)await client.query('ROLLBACK').catch(()=>{});
  await client.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 try{
  const outcome=await testHcSecureDisposableSchema();
  process.stdout.write('HC_SECURE_DISPOSABLE_SCHEMA_OK fixtures='+outcome.fixtureCount+
   ' tables='+outcome.tables+' nonlogin_groups='+outcome.groups+
   ' rollback=true\n');
 }catch{
  console.error('HC_SECURE_DISPOSABLE_SCHEMA_BLOCKED');
  process.exitCode=1;
 }
}
