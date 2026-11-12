#!/usr/bin/env node
import pg from 'pg';
import {checkOwnerBootstrapScope} from './bootstrap-owner-stage-database.mjs';
const roles=['hc_owner_stage_runtime','hc_owner_stage_operator'];
export function checkLockedRoleEnvironment(env={}){
 if(env.HC_OWNER_ROLE_PREPARE_ONLY!=='true'||env.HC_OWNER_STAGING_ENABLED==='true'||
   env.HC_OWNER_OPERATOR_DATABASE_URL||env.HC_OWNER_STAGING_DATABASE_URL||
   env.HC_OWNER_OPERATOR_ACK||env.HC_OWNER_TIMECLOCK_EMPLOYEE_ID||
   env.HC_OWNER_TIMECLOCK_SERVICE_SECRET)
  throw Error('Locked Owner role preparation refused');
 return checkOwnerBootstrapScope(env);
}
function refuse(){throw Error('Owner locked roles rejected unexpected DB or privileges')}
export async function prepareLockedOwnerRoles(env=process.env){
 const uri=checkLockedRoleEnvironment(env);
 uri.pathname='/hc_owner_stage_test';
 const db=new pg.Client({connectionString:uri.toString(),connectionTimeoutMillis:7000});
 await db.connect();
 try{
  await db.query('BEGIN');
  try{
   await db.query("SET LOCAL lock_timeout='3s'");
   await db.query("SET LOCAL statement_timeout='30s'");
   const ctx=await db.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::integer AS v");
   if(ctx.rows[0]?.db!=='hc_owner_stage_test'||ctx.rows[0]?.role!=='postgres'||
      ctx.rows[0]?.v<180000||ctx.rows[0]?.v>=190000)refuse();
   const counts=await db.query("SELECT (SELECT count(*) FROM hc_admin_principals)::integer AS owners,(SELECT count(*) FROM hc_first_owner_activations)::integer AS activations");
   if(counts.rows[0].owners!==0||counts.rows[0].activations!==0)refuse();
   const previous=await db.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])",[roles]);
   if(previous.rowCount!==0)refuse(); // Never modify an existing login.
   const groups=await db.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1::text[])",[
    ['hc_owner_stage_runtime_privs','hc_owner_stage_operator_privs']]);
   if(groups.rowCount!==2||groups.rows.some(r=>r.rolcanlogin||r.rolsuper||r.rolcreatedb||r.rolcreaterole))refuse();
   await db.query("CREATE ROLE hc_owner_stage_runtime LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT");
   await db.query("CREATE ROLE hc_owner_stage_operator LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT");
   await db.query("GRANT hc_owner_stage_runtime_privs TO hc_owner_stage_runtime");
   await db.query("GRANT hc_owner_stage_operator_privs TO hc_owner_stage_operator");
   const auth=await db.query(
    "SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolinherit,a.rolpassword IS NULL AS locked FROM pg_roles r JOIN pg_authid a ON a.oid=r.oid WHERE r.rolname=ANY($1::text[])",[roles]);
   if(auth.rowCount!==2||auth.rows.some(r=>!r.rolcanlogin||!r.locked||r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolreplication||r.rolbypassrls||!r.rolinherit))refuse();
   const grants=await db.query(
    "SELECT pg_has_role($1,'hc_owner_stage_runtime_privs','MEMBER') AS rr,pg_has_role($1,'hc_owner_stage_operator_privs','MEMBER') AS ro,pg_has_role($2,'hc_owner_stage_operator_privs','MEMBER') AS oo,pg_has_role($2,'hc_owner_stage_runtime_privs','MEMBER') AS orole,has_table_privilege($1,'hc_first_owner_activations','INSERT') AS rissue,has_table_privilege($2,'hc_staff_totp','SELECT') AS ototp",roles);
   const g=grants.rows[0];if(!g||!g.rr||!g.oo||g.ro||g.orole||g.rissue||g.ototp)refuse();
   await db.query('COMMIT');
   return Object.freeze({lockedLogins:2,activations:0});
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 }finally{await db.end().catch(()=>{})}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 try{const r=await prepareLockedOwnerRoles();
  process.stdout.write('HC_OWNER_LOCKED_LOGINS_OK count='+r.lockedLogins+' password_states=NULL activations='+r.activations+'\n');
 }catch{console.error('HC_OWNER_LOCKED_LOGINS_REFUSED_OR_FAILED');process.exitCode=1;}
}
