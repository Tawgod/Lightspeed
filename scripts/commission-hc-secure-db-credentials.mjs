#!/usr/bin/env node
// One-time credential commissioning for NEW HC Secure staging PG18 ONLY.
// Offline operator service; NEVER run in public login server or original Owner.
// Requires separate human approval before running against any real Railway DB.
// This script is NOT deployed by this commit.
import pg from 'pg';
import {verifyHcSecureCredentialCommissioningScope}
 from '../services/security/hcSecureCredentialCommissioningPreflight.js';
import {verifyOwnerStagingDatabasePrivileges}
 from '../services/security/ownerStagingDatabasePreflight.js';

const RUNTIME='hc_owner_stage_runtime', OPERATOR='hc_owner_stage_operator';
const ROLE_NAMES=[RUNTIME,OPERATOR];
const denied=()=>new Error('HC Secure credential commissioning blocked.');
function loginUrl(root,role,password){
 const url=new URL(root);
 url.pathname='/hc_owner_stage_test';
 url.username=role;url.password=password;
 return url.toString();
}
async function verifyPreconditions(root){
 const context=await root.query(
  "SELECT current_database() AS db,current_user AS role,"+
  "current_setting('server_version_num')::integer AS version,"+
  "(SELECT count(*) FROM hc_admin_principals)::integer AS owners,"+
  "(SELECT count(*) FROM hc_first_owner_activations)::integer AS activations"
 );
 const c=context.rows?.[0];
 if(context.rowCount!==1||c?.db!=='hc_owner_stage_test'||
    c?.role!=='postgres'||c?.version<180000||c?.version>=190000||
    c?.owners!==0||c?.activations!==0)throw denied();
 const roles=await root.query(
  "SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,"+
  "r.rolreplication,r.rolbypassrls,r.rolinherit,a.rolpassword IS NULL AS locked "+
  "FROM pg_roles r JOIN pg_authid a ON a.oid=r.oid WHERE r.rolname=ANY($1::text[])",[ROLE_NAMES]
 );
 if(roles.rowCount!==2||roles.rows.some(x=>!x.rolcanlogin||!x.locked||
   x.rolsuper||x.rolcreatedb||x.rolcreaterole||
   x.rolreplication||x.rolbypassrls||!x.rolinherit))throw denied();
 const grants=await root.query(
  "SELECT pg_has_role($1,'hc_owner_stage_runtime_privs','MEMBER') AS rr,"+
  "pg_has_role($1,'hc_owner_stage_operator_privs','MEMBER') AS ro,"+
  "pg_has_role($2,'hc_owner_stage_operator_privs','MEMBER') AS oo,"+
  "pg_has_role($2,'hc_owner_stage_runtime_privs','MEMBER') AS orole",
  ROLE_NAMES
 );
 const g=grants.rows?.[0];
 if(grants.rowCount!==1||!g||!g.rr||g.ro||!g.oo||g.orole)throw denied();
}
async function verifyRoleLogin({rootUrl,role,password,createClient}){
 const c=createClient({connectionString:loginUrl(rootUrl,role,password),connectionTimeoutMillis:6000});
 try{
  await c.connect();
  const q=await c.query(
   "SELECT current_database() AS db,current_user AS who,"+
   "has_table_privilege(current_user,'hc_first_owner_activations','INSERT') AS issue,"+
   "has_table_privilege(current_user,'hc_first_owner_activations','DELETE') AS drop_approval,"+
   "has_table_privilege(current_user,'hc_staff_totp','SELECT') AS totp_read,"+
   "has_column_privilege(current_user,'hc_first_owner_activations','consumed_at','UPDATE') AS consume"
  );
  const a=q.rows?.[0];
  if(q.rowCount!==1||a?.db!=='hc_owner_stage_test'||a?.who!==role||
     a.drop_approval!==false)throw denied();
  if(role===RUNTIME && (a.issue!==false||a.consume!==true||a.totp_read!==true))
   throw denied();
  if(role===OPERATOR && (a.issue!==true||a.consume!==false||a.totp_read!==false))
   throw denied();
 }finally{await c.end().catch(()=>{});}
}
async function verifyBadPasswordDenied({rootUrl,createClient}){
 const wrong='not-a-valid-hc-secure-generated-password';
 const c=createClient({
  connectionString:loginUrl(rootUrl,RUNTIME,wrong),
  connectionTimeoutMillis:5000
 });
 let accepted=false;
 try{
  await c.connect();
  accepted=true;
 }catch{/* A denied wrong-password authentication is expected. */}
 finally{await c.end().catch(()=>{});}
 if(accepted)throw denied();
}
async function lockRoles({root,committed}){
 // Roles were PASSWORD NULL before this operation. Re-lock on any failure
 // after writing passwords, including a failure after COMMIT.
 // Use a *new transaction* when the initial transaction was committed.
 if(committed){
  await root.query('BEGIN');
  try{
   await root.query('ALTER ROLE hc_owner_stage_runtime PASSWORD NULL');
   await root.query('ALTER ROLE hc_owner_stage_operator PASSWORD NULL');
   await root.query('COMMIT');
  }catch(e){await root.query('ROLLBACK').catch(()=>{});throw e;}
 }else{
  await root.query('ROLLBACK');
 }
}
export async function commissionHcSecureCredentials({
 environment=process.env,
 createClient=opts=>new pg.Client(opts),
 createPool=opts=>new pg.Pool(opts)
}={}){
 verifyHcSecureCredentialCommissioningScope(environment);
 const rootUrl=new URL(environment.HC_SECURE_BOOTSTRAP_ROOT_URL);
 rootUrl.pathname='/hc_owner_stage_test';
 const root=createClient({connectionString:rootUrl.toString(),connectionTimeoutMillis:7000});
 let begun=false,committed=false,modified=false,rootConnected=false;
 try{
  await root.connect();rootConnected=true;
  await root.query('BEGIN');begun=true;
  await root.query("SET LOCAL statement_timeout='30s'");
  await root.query("SET LOCAL lock_timeout='3s'");
  await root.query("SET LOCAL password_encryption='scram-sha-256'");
  await verifyPreconditions(root);
  // Validation requires exactly 48 ASCII alphanumeric chars; SQL injection
  // cannot add statement syntax. Values are NEVER printed, logged or returned.
  await root.query("ALTER ROLE hc_owner_stage_runtime PASSWORD '"+environment.HC_SECURE_DB_RUNTIME_PASSWORD+"'");
  modified=true;
  await root.query("ALTER ROLE hc_owner_stage_operator PASSWORD '"+environment.HC_SECURE_DB_OPERATOR_PASSWORD+"'");
  const hashes=await root.query(
   "SELECT rolname,rolpassword LIKE 'SCRAM-SHA-256$%' AS scram "+
   "FROM pg_authid WHERE rolname=ANY($1::text[])",[ROLE_NAMES]
  );
  if(hashes.rowCount!==2||hashes.rows.some(x=>x.scram!==true))throw denied();
  await root.query('COMMIT');committed=true;begun=false;

  await verifyRoleLogin({rootUrl,role:RUNTIME,
   password:environment.HC_SECURE_DB_RUNTIME_PASSWORD,createClient});
  const runtimePool=createPool({
   connectionString:loginUrl(rootUrl,RUNTIME,environment.HC_SECURE_DB_RUNTIME_PASSWORD),
   max:1,connectionTimeoutMillis:6000
  });
  try{await verifyOwnerStagingDatabasePrivileges({pool:runtimePool});}
  finally{await runtimePool.end().catch(()=>{});}
  await verifyRoleLogin({rootUrl,role:OPERATOR,
   password:environment.HC_SECURE_DB_OPERATOR_PASSWORD,createClient});
  await verifyBadPasswordDenied({rootUrl,createClient});
  return Object.freeze({runtimeVerified:true,operatorVerified:true,
   badPasswordDenied:true,activations:0});
 }catch{
  if(rootConnected){
   if(modified||begun){
    // Any failed rollback/relock must be surfaced as an incident, not success.
    try{await lockRoles({root,committed});}
    catch{throw new Error('HC Secure commissioning failed; DB role state requires manual security review.');}
   }
  }
  throw denied();
 }finally{await root.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 try{
  const r=await commissionHcSecureCredentials();
  console.log('HC_SECURE_CREDENTIALS_OK runtime='+r.runtimeVerified+
   ' operator='+r.operatorVerified+' wrong_password_denied='+r.badPasswordDenied+
   ' activations='+r.activations);
 }catch{
  console.error('HC_SECURE_CREDENTIALS_BLOCKED_OR_REQUIRES_REVIEW');
  process.exitCode=1;
 }
}
