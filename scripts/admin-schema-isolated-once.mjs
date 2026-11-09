import pg from 'pg';
import {readFile} from 'node:fs/promises';

const EXPECTED_SERVICE='Postgres-O39p';
const fail=message=>{throw new Error('Isolated Admin schema setup refused: '+message);};
export function validateAdminMigrationTarget(env){
 if(env.HC_ADMIN_SCHEMA_MIGRATION_ENABLED!=='true')fail('missing explicit migration opt-in');
 if(env.HC_ADMIN_SCHEMA_MIGRATION_TARGET!==EXPECTED_SERVICE)fail('wrong target service');
 if(env.HC_ADMIN_SCHEMA_MIGRATION_ENVIRONMENT!=='test')fail('not the isolated test environment');
 if(typeof env.HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_HOST!=='string'||
    !env.HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_HOST.endsWith('.railway.internal'))
  fail('expected Railway private host not verified');
 if(typeof env.HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_DB!=='string'||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(env.HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_DB))
  fail('expected database name missing');
 let uri;
 try{uri=new URL(env.HC_ADMIN_SCHEMA_DATABASE_URL||'');}
 catch{fail('database URL missing');}
 if(!['postgresql:','postgres:'].includes(uri.protocol)||
    uri.hostname!==env.HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_HOST||
    decodeURIComponent(uri.pathname.slice(1))!==env.HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_DB||
    !uri.username||!uri.password||uri.search||uri.hash)
  fail('database URL is not the intended private test database');
 return Object.freeze({host:uri.hostname,database:env.HC_ADMIN_SCHEMA_MIGRATION_EXPECTED_DB});
}
export async function runAdminSchemaMigration({env=process.env,poolFactory=opts=>new pg.Pool(opts),loadSql=()=>readFile(new URL('../db/hc_admin_delegations.sql',import.meta.url),'utf8')}={}){
 const target=validateAdminMigrationTarget(env);
 const pool=poolFactory({connectionString:env.HC_ADMIN_SCHEMA_DATABASE_URL,
  max:1,connectionTimeoutMillis:5000,statement_timeout:15000,
  application_name:'hc-isolated-admin-schema-once'});
 let client,transaction=false;
 try{
  client=await pool.connect();
  await client.query('BEGIN');transaction=true;
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query("SELECT pg_advisory_xact_lock(479102, 51)");
  const actual=await client.query('SELECT current_database() AS database, current_user AS username');
  if(actual.rowCount!==1||actual.rows[0].database!==target.database)
   fail('connected database identity mismatch');
  // Reject any pre-existing administrator records. This is an empty isolated
  // setup, NEVER a production migration or Owner-commissioning script.
  const exists=await client.query("SELECT to_regclass('public.hc_admin_principals') AS relation");
  if(exists.rows[0]?.relation) {
   const check=await client.query('SELECT count(*)::integer AS n FROM public.hc_admin_principals');
   if(check.rows[0]?.n!==0)fail('database already holds employee principals');
  }
  await client.query(await loadSql());
  const tables=await client.query(`SELECT count(*)::integer AS n
    FROM information_schema.tables WHERE table_schema='public'
    AND table_name=ANY($1::text[])`,[[
    'hc_admin_principals','hc_admin_grants','hc_admin_grant_scopes',
    'hc_admin_setting_scopes','hc_employee_tool_grants',
    'hc_admin_authorization_events'
  ]]);
  if(tables.rows[0]?.n!==6)fail('canonical schema incomplete');
  const empty=await client.query(`SELECT
   (SELECT count(*)::integer FROM public.hc_admin_principals) AS principals,
   (SELECT count(*)::integer FROM public.hc_admin_grants) AS grants`);
  if(empty.rows[0]?.principals!==0||empty.rows[0]?.grants!==0)
   fail('employee roles or admin grants unexpectedly present');
  await client.query('COMMIT');transaction=false;
  return Object.freeze({schemaReady:true,principals:0,grants:0,service:EXPECTED_SERVICE});
 }catch(error){
  if(transaction&&client)await client.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{
  client?.release();
  await pool.end();
 }
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
 runAdminSchemaMigration().then(result=>{
  console.log('Isolated Admin schema setup verified: '+result.service+
   '; no employee principals or grants created.');
 }).catch(error=>{
  console.error(error.message);
  process.exitCode=1;
 });
}
