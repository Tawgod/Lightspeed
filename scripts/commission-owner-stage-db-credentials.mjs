#!/usr/bin/env node
// One-time isolated staging ONLY. No logging of passwords or human identities.
import pg from 'pg';
import {checkOwnerBootstrapScope} from './bootstrap-owner-stage-database.mjs';
import {verifyOwnerStagingDatabasePrivileges} from '../services/security/ownerStagingDatabasePreflight.js';
const R='hc_owner_stage_runtime',O='hc_owner_stage_operator';
const format=x=>typeof x==='string'&&/^[A-Za-z0-9]{48}$/.test(x);
const fail=()=>{throw Error('Owner staged credential commissioning refused')};
const signers=['HC_OWNER_SESSION_SECRET','HC_OWNER_THROTTLE_SECRET','HC_OWNER_PASSKEY_SIGNING_SECRET','HC_OWNER_APPROVAL_HMAC_SECRET','HC_OWNER_MFA_SESSION_SECRET'];
export function checkCredentialScope(e={}){
 if(e.HC_OWNER_CREDENTIAL_COMMISSION_ONLY!=='true'||e.HC_OWNER_ROLE_PREPARE_ONLY||
    e.HC_OWNER_STAGING_ENABLED==='true'||e.HC_OWNER_OPERATOR_ACK||
    e.HC_OWNER_TIMECLOCK_EMPLOYEE_ID||e.HC_OWNER_OPERATOR_DATABASE_URL||
    e.HC_OWNER_STAGING_DATABASE_URL)fail();
 const url=checkOwnerBootstrapScope(e);
 const secrets=['HC_OWNER_DB_RUNTIME_PASSWORD','HC_OWNER_DB_OPERATOR_PASSWORD',...signers];
 if(secrets.some(k=>!format(e[k]))||new Set(secrets.map(k=>e[k])).size!==secrets.length)fail();
 const t=e.HC_OWNER_TOTP_ENCRYPTION_KEY;
 if(typeof t!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(t)||
    Buffer.from(t,'base64').length!==32)fail();
 return url;
}
const connection=async(root,name,password)=>{
 const url=new URL(root);url.pathname='/hc_owner_stage_test';url.username=name;url.password=password;
 const c=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:7000});
 await c.connect();return c;
};
async function verifyLogins(url,e){
 let runtime,operator;
 try{
  runtime=await connection(url,R,e.HC_OWNER_DB_RUNTIME_PASSWORD);
  const rr=await runtime.query("SELECT current_user AS who,has_table_privilege(current_user,'hc_first_owner_activations','SELECT') AS see,has_table_privilege(current_user,'hc_first_owner_activations','INSERT') AS issue,has_table_privilege(current_user,'hc_first_owner_activations','DELETE') AS drop,has_column_privilege(current_user,'hc_first_owner_activations','activation_digest','UPDATE') AS alter_digest,has_column_privilege(current_user,'hc_first_owner_activations','consumed_at','UPDATE') AS consume");
  const a=rr.rows[0];if(a?.who!==R||!a.see||a.issue||a.drop||a.alter_digest||!a.consume)fail();
  const pool=new pg.Pool({connectionString:(()=>{const u=new URL(url);u.pathname='/hc_owner_stage_test';u.username=R;u.password=e.HC_OWNER_DB_RUNTIME_PASSWORD;return u.toString()})(),max:1,connectionTimeoutMillis:7000});
  try{await verifyOwnerStagingDatabasePrivileges({pool})}finally{await pool.end().catch(()=>{})}
  operator=await connection(url,O,e.HC_OWNER_DB_OPERATOR_PASSWORD);
  const op=await operator.query("SELECT current_user AS who,has_table_privilege(current_user,'hc_first_owner_activations','INSERT') AS issue,has_table_privilege(current_user,'hc_staff_totp','SELECT') AS totp,has_column_privilege(current_user,'hc_first_owner_activations','consumed_at','UPDATE') AS consume");
  const b=op.rows[0];if(b?.who!==O||!b.issue||b.totp||b.consume)fail();
 }finally{await runtime?.end().catch(()=>{});await operator?.end().catch(()=>{})}
 // The private network must reject an incorrect password.
 let bad;let accepted=false;
 try{bad=await connection(url,R,'not-a-valid-generated-password');accepted=true}catch{}
 finally{await bad?.end().catch(()=>{})}
 if(accepted)fail();
}
export async function commissionOwnerStageCredentials(e=process.env){
 const url=checkCredentialScope(e);
 const target=new URL(url);target.pathname='/hc_owner_stage_test';
 const root=new pg.Client({connectionString:target.toString(),connectionTimeoutMillis:7000});
 let changed=false;
 await root.connect();
 try{
  await root.query('BEGIN');
  try{
   const ctx=await root.query("SELECT current_database() AS db,current_user AS role,(SELECT count(*) FROM hc_admin_principals)::integer AS owners,(SELECT count(*) FROM hc_first_owner_activations)::integer AS activations");
   const a=ctx.rows[0];
   if(a?.db!=='hc_owner_stage_test'||a?.role!=='postgres'||a.owners!==0||a.activations!==0)fail();
   const roles=await root.query("SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreaterole,r.rolcreatedb,a.rolpassword IS NULL AS locked FROM pg_roles r JOIN pg_authid a ON a.oid=r.oid WHERE r.rolname=ANY($1::text[])",[[R,O]]);
   if(roles.rowCount!==2||roles.rows.some(x=>!x.rolcanlogin||x.rolsuper||x.rolcreaterole||x.rolcreatedb||!x.locked))fail();
   const memberships=await root.query("SELECT pg_has_role($1,'hc_owner_stage_runtime_privs','MEMBER') AS rr,pg_has_role($1,'hc_owner_stage_operator_privs','MEMBER') AS ro,pg_has_role($2,'hc_owner_stage_operator_privs','MEMBER') AS oo,pg_has_role($2,'hc_owner_stage_runtime_privs','MEMBER') AS orole",[R,O]);
   const m=memberships.rows[0];if(!m||!m.rr||m.ro||!m.oo||m.orole)fail();
   // Input is exactly 48 alphanumeric chars, never a SQL metacharacter.
   await root.query("ALTER ROLE hc_owner_stage_runtime PASSWORD '"+e.HC_OWNER_DB_RUNTIME_PASSWORD+"'");
   await root.query("ALTER ROLE hc_owner_stage_operator PASSWORD '"+e.HC_OWNER_DB_OPERATOR_PASSWORD+"'");
   changed=true;
   const hashes=await root.query("SELECT rolname,rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid WHERE rolname=ANY($1::text[])",[[R,O]]);
   if(hashes.rowCount!==2||hashes.rows.some(x=>!x.scram))fail();
   await root.query('COMMIT');
  }catch(error){await root.query('ROLLBACK').catch(()=>{});throw error}
  await verifyLogins(url,e);
  return Object.freeze({runtime:true,operator:true,activations:0});
 }catch(error){
  if(changed){
   await root.query('ALTER ROLE hc_owner_stage_runtime PASSWORD NULL').catch(()=>{});
   await root.query('ALTER ROLE hc_owner_stage_operator PASSWORD NULL').catch(()=>{});
  }
  throw error;
 }finally{await root.end().catch(()=>{})}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 try{const r=await commissionOwnerStageCredentials();
  console.log('HC_OWNER_DB_CREDENTIALS_OK runtime='+r.runtime+' operator='+r.operator+' wrong_password_denied=true activations='+r.activations);
 }catch{console.error('HC_OWNER_DB_CREDENTIALS_REFUSED_OR_FAILED');process.exitCode=1}
}
