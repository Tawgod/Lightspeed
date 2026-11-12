#!/usr/bin/env node
// ONE-TIME, PRIVATE RAILWAY STAGING DATABASE PROVISIONER.
//
// No Owner identity, public web endpoint, password, activation, or credential
// is issued here. It only constructs a fresh database, reviewed prerequisite
// schema, and two NOLOGIN privilege groups. Never attach to production.
import pg from 'pg';
import {readFile} from 'node:fs/promises';

export const OWNER_STAGE_FIXTURES=Object.freeze([
 'db/hc_admin_delegations.sql',
 'db/hc_staff_passkeys.sql',
 'db/hc_staff_auth_throttle.sql',
 'db/hc_staff_factor_approvals.sql',
 'db/hc_staff_totp.sql',
 'db/hc_first_owner_operator_activation.sql',
 'db/hc_owner_staging_privilege_groups.sql'
]);

const PROJECT='5b46096d-3178-47ec-ba88-d5037696346a';
const ENVIRONMENT='46b93c76-3085-4e76-a37d-90dfdd250dd2';
const SERVICE='hc-owner-db-bootstrap';
const DATABASE='hc_owner_stage_test';
const TABLES=Object.freeze([
 'hc_admin_principals','hc_staff_passkeys','hc_staff_passkey_challenges',
 'hc_staff_passkey_events','hc_staff_auth_throttle','hc_staff_factor_approvals',
 'hc_staff_totp','hc_first_owner_activations','hc_first_owner_activation_events'
]);

function refuse(){throw Error('Owner database bootstrap refused (staging-only safety boundary).');}
export function checkOwnerBootstrapScope(env={}){
 if(env.NODE_ENV!=='test'||env.HC_SECURITY_ENV!=='isolated-staging'||
    env.HC_OWNER_DB_PROVISION_ONLY!=='true'||
    env.RAILWAY_PROJECT_ID!==PROJECT||
    env.RAILWAY_ENVIRONMENT_ID!==ENVIRONMENT||
    env.RAILWAY_SERVICE_NAME!==SERVICE||
    env.HC_OWNER_STAGING_ENABLED==='true'||
    env.OWNER_STAGING_IDENTITY_ENABLED==='true'||
    env.HC_STAGING_TEST_LOGIN_ENABLED==='true'||
    env.HC_STAGING_PIN_SETUP_ENABLED==='true'||
    ['OWNER_STAGING_SERVICE_SECRET','HC_OWNER_TIMECLOCK_SERVICE_SECRET',
      'LIGHTSPEED_TOKEN','DISCORD_TOKEN'].some(key=>env[key]))
  refuse();
 let u;
 try{u=new URL(env.HC_OWNER_BOOTSTRAP_DATABASE_URL);}catch{refuse();}
 if(u.protocol!=='postgresql:'&&u.protocol!=='postgres:')refuse();
 if(!/^[a-z0-9-]+\.railway\.internal$/i.test(u.hostname)||
    u.pathname!=='/railway'||u.username!=='postgres'||
    !u.password||u.password.length<16||u.hash||u.search)refuse();
 return u;
}
async function assertEmpty(client){
 const existing=await client.query(
  "SELECT to_regclass('public.hc_admin_principals') AS principals, "+
  "to_regclass('public.hc_first_owner_activations') AS activations"
 );
 if(existing.rows[0].principals){
  const r=await client.query('SELECT COUNT(*)::integer AS count FROM hc_admin_principals');
  if(r.rows[0].count!==0)refuse();
 }
 if(existing.rows[0].activations){
  const r=await client.query('SELECT COUNT(*)::integer AS count FROM hc_first_owner_activations');
  if(r.rows[0].count!==0)refuse();
 }
}
async function assertLeastPrivilege(client){
 const r=await client.query(
  "SELECT rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb FROM pg_roles "+
  "WHERE rolname IN ('hc_owner_stage_runtime_privs','hc_owner_stage_operator_privs')"
 );
 if(r.rowCount!==2||r.rows.some(x=>x.rolcanlogin||x.rolsuper||x.rolcreaterole||x.rolcreatedb))
  refuse();
 const t=await client.query(
  "SELECT "+TABLES.map((_,i)=>"to_regclass($"+(i+1)+"::text) IS NOT NULL AS t"+i).join(', '),
  TABLES
 );
 if(t.rowCount!==1||!TABLES.every((_,i)=>t.rows[0]['t'+i]))refuse();
 const checks=await client.query(
  "SELECT "+
  "has_table_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','SELECT') AS runtime_read, "+
  "has_table_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','INSERT') AS runtime_issue, "+
  "has_table_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','DELETE') AS runtime_delete, "+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','activation_digest','UPDATE') AS runtime_rewrite, "+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','employee_id','UPDATE') AS runtime_reassign, "+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','expires_at','UPDATE') AS runtime_extend, "+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','consumed_at','UPDATE') AS runtime_consume, "+
  "has_column_privilege('hc_owner_stage_runtime_privs','hc_first_owner_activations','credential_id','UPDATE') AS runtime_credential, "+
  "has_table_privilege('hc_owner_stage_operator_privs','hc_first_owner_activations','INSERT') AS operator_issue, "+
  "has_table_privilege('hc_owner_stage_operator_privs','hc_staff_totp','SELECT') AS operator_totp, "+
  "has_column_privilege('hc_owner_stage_operator_privs','hc_first_owner_activations','consumed_at','UPDATE') AS operator_consume"
 );
 const q=checks.rows[0];
 if(!q||q.runtime_read!==true||q.runtime_issue!==false||
    q.runtime_delete!==false||q.runtime_rewrite!==false||
    q.runtime_reassign!==false||q.runtime_extend!==false||
    q.runtime_consume!==true||q.runtime_credential!==true||
    q.operator_issue!==true||q.operator_totp!==false||
    q.operator_consume!==false)refuse();
 return Object.freeze({tables:TABLES.length,groups:r.rowCount});
}
export async function provisionOwnerStageDatabase(env=process.env){
 const rootUrl=checkOwnerBootstrapScope(env);
 const root=new pg.Client({connectionString:rootUrl.toString(),connectionTimeoutMillis:8000});
 let target;
 try{
  await root.connect();
  const info=await root.query(
   "SELECT current_database() AS db,current_user AS role,"+
   "current_setting('server_version_num')::integer AS version"
  );
  if(info.rows[0].db!=='railway'||info.rows[0].role!=='postgres'||
      info.rows[0].version<180000||info.rows[0].version>=190000)refuse();
  const present=await root.query(
   "SELECT 1 FROM pg_database WHERE datname=$1",[DATABASE]
  );
  if(present.rowCount===0)await root.query('CREATE DATABASE '+DATABASE);
  else if(present.rowCount!==1)refuse();
  const targetUrl=new URL(rootUrl);
  targetUrl.pathname='/'+DATABASE;
  target=new pg.Client({connectionString:targetUrl.toString(),connectionTimeoutMillis:8000});
  await target.connect();
  await target.query('BEGIN');
  try{
   await target.query("SET LOCAL lock_timeout='3s'");
   await target.query("SET LOCAL statement_timeout='40s'");
   await assertEmpty(target);
   for(const path of OWNER_STAGE_FIXTURES){
    const sql=await readFile(new URL('../'+path,import.meta.url),'utf8');
    await target.query(sql);
   }
   await target.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
   await target.query('REVOKE ALL ON DATABASE '+DATABASE+' FROM PUBLIC');
   await target.query('GRANT CONNECT ON DATABASE '+DATABASE+
     ' TO hc_owner_stage_runtime_privs,hc_owner_stage_operator_privs');
   const result=await assertLeastPrivilege(target);
   await target.query('COMMIT');
   return result;
  }catch(error){
   await target.query('ROLLBACK').catch(()=>{});
   throw error;
  }
 }finally{
  await target?.end().catch(()=>{});
  await root.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 try{
  const result=await provisionOwnerStageDatabase();
  // Intentionally no role names, URLs, passwords, employee data, or secrets
  // written to logs. Success only confirms nonlogin groups and schema.
  process.stdout.write('HC_OWNER_DB_BOOTSTRAP_OK tables='+result.tables+
    ' nonlogin_groups='+result.groups+' owner_activations=0\n');
 }catch{
  console.error('HC_OWNER_DB_BOOTSTRAP_REFUSED_OR_FAILED');
  process.exitCode=1;
 }
}
