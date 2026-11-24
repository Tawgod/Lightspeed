#!/usr/bin/env node
// HC Secure one-time isolated PG18 role preparation (NO PASSWORDS).
// Must run separately from and after the fresh-schema bootstrap, using an
// operator-only staging service, never from the public login server.
import pg from 'pg';
import {checkHcSecureBootstrapScope} from './bootstrap-hc-secure-staging-db.mjs';
const ROLES=['hc_owner_stage_runtime','hc_owner_stage_operator'];
const GROUPS=['hc_owner_stage_runtime_privs','hc_owner_stage_operator_privs'];
const fail=()=>new Error('HC Secure locked role preparation refused.');
export function checkHcSecureLockedRoleScope(e={}){
 if(e.HC_SECURE_ROLE_PREPARE_ONLY!=='true'||
    e.HC_SECURE_DB_BOOTSTRAP_ONLY!=='false'||
    e.HC_SECURE_CREDENTIAL_COMMISSION_ONLY!=='false'||
    e.HC_SECURE_DB_MUTATION_APPROVED!=='HC_SECURE_LOCKED_ROLES_ONLY'||
    e.HC_OWNER_TIMECLOCK_EMPLOYEE_ID||e.HC_OWNER_DB_RUNTIME_PASSWORD||
    e.HC_OWNER_DB_OPERATOR_PASSWORD||e.HC_OWNER_STAGING_DATABASE_URL||
    e.HC_OWNER_OPERATOR_DATABASE_URL)throw fail();
 // Reuse exact Railway/PG URL safety scope, but require a distinct explicit
 // approval sentinel for this one-shot action, never a shared operation flag.
 // Adapt only the local validation copy; never enable the schema operation in the real environment.
 const scope={...e,HC_SECURE_DB_BOOTSTRAP_ONLY:'true',HC_SECURE_DB_MUTATION_APPROVED:'HC_SECURE_FRESH_DB_SCHEMA_ONLY'};
 return checkHcSecureBootstrapScope(scope);
}
export async function prepareHcSecureLockedRoles({
 environment=process.env,createClient=opts=>new pg.Client(opts)
}={}){
 const rootUrl=checkHcSecureLockedRoleScope(environment);
 const target=new URL(rootUrl);target.pathname='/hc_owner_stage_test';
 const client=createClient({connectionString:target.toString(),connectionTimeoutMillis:7000});
 let begun=false;
 try{
  await client.connect();
  await client.query('BEGIN');begun=true;
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query("SET LOCAL lock_timeout='3s'");
  const ctx=await client.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::integer AS version");
  const c=ctx.rows?.[0];
  if(ctx.rowCount!==1||c?.db!=='hc_owner_stage_test'||c?.role!=='postgres'||
     c?.version<180000||c?.version>=190000)throw fail();
  const owners=await client.query("SELECT (SELECT COUNT(*) FROM hc_admin_principals)::integer AS owners,(SELECT COUNT(*) FROM hc_first_owner_activations)::integer AS activations");
  if(owners.rows?.[0]?.owners!==0||owners.rows?.[0]?.activations!==0)throw fail();
  const roles=await client.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])",[ROLES]);
  if(roles.rowCount!==0)throw fail(); // Prevent duplicate or reset of logins.
  const groups=await client.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1::text[])",[GROUPS]);
  if(groups.rowCount!==2||groups.rows.some(x=>x.rolcanlogin||x.rolsuper||x.rolcreatedb||x.rolcreaterole))throw fail();
  await client.query("CREATE ROLE hc_owner_stage_runtime LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT");
  await client.query("CREATE ROLE hc_owner_stage_operator LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT");
  await client.query("GRANT hc_owner_stage_runtime_privs TO hc_owner_stage_runtime");
  await client.query("GRANT hc_owner_stage_operator_privs TO hc_owner_stage_operator");
  const auth=await client.query("SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolinherit,a.rolpassword IS NULL AS locked FROM pg_roles r JOIN pg_authid a ON a.oid=r.oid WHERE r.rolname=ANY($1::text[])",[ROLES]);
  if(auth.rowCount!==2||auth.rows.some(x=>!x.rolcanlogin||!x.locked||x.rolsuper||
     x.rolcreatedb||x.rolcreaterole||x.rolreplication||x.rolbypassrls||!x.rolinherit))throw fail();
  const grants=await client.query("SELECT pg_has_role($1,'hc_owner_stage_runtime_privs','MEMBER') AS rr,pg_has_role($1,'hc_owner_stage_operator_privs','MEMBER') AS ro,pg_has_role($2,'hc_owner_stage_operator_privs','MEMBER') AS oo,pg_has_role($2,'hc_owner_stage_runtime_privs','MEMBER') AS orole,has_table_privilege($1,'hc_first_owner_activations','INSERT') AS issue,has_table_privilege($2,'hc_staff_totp','SELECT') AS totp",ROLES);
  const g=grants.rows?.[0];
  if(grants.rowCount!==1||!g||!g.rr||!g.oo||g.ro||g.orole||g.issue||g.totp)throw fail();
  await client.query('COMMIT');begun=false;
  return Object.freeze({lockedLogins:2,passwordsConfigured:false,activations:0});
 }catch{
  if(begun)await client.query('ROLLBACK').catch(()=>{});
  throw fail();
 }finally{await client.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 try{
  const result=await prepareHcSecureLockedRoles();
  console.log('HC_SECURE_LOCKED_ROLES_OK count='+result.lockedLogins+' passwords_set=false');
 }catch{
  console.error('HC_SECURE_LOCKED_ROLES_BLOCKED');process.exitCode=1;
 }
}
