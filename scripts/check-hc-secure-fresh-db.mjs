import pg from 'pg';

// Read-only HC Secure fresh database readiness probe. This never creates,
// resets or migrates a DB, and cannot connect to the original Owner project.
export const HC_SECURE_HOST='hc-secure-postgres-staging.railway.internal';
export const HC_SECURE_DB='hc_owner_stage_test';
export const REQUIRED_TABLES=Object.freeze([
 'hc_admin_principals','hc_staff_passkeys','hc_staff_passkey_challenges',
 'hc_staff_passkey_events','hc_staff_auth_throttle','hc_staff_factor_approvals',
 'hc_staff_totp','hc_first_owner_activations','hc_first_owner_activation_events'
]);
const fail=()=>new Error('HC Secure fresh database preflight blocked.');
export function checkHcSecureDatabaseTarget(env={}){
 if(env.RAILWAY_PROJECT_ID!=='120de974-f2e8-46be-9a00-8eb8b1be4cc4' ||
    env.RAILWAY_ENVIRONMENT_ID!=='8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c')
  throw fail();
 let url;
 try{url=new URL(env.HC_SECURE_PREPARE_DATABASE_URL);}catch{throw fail();}
 if(!['postgres:','postgresql:'].includes(url.protocol) ||
    url.hostname!==HC_SECURE_HOST ||
    url.pathname!=='/'+HC_SECURE_DB ||
    !url.username || !url.password || url.search || url.hash)
  throw fail();
 if(env.HC_SECURE_PREPARE_DATABASE_URL===env.HC_OWNER_STAGING_DATABASE_URL ||
    env.HC_SECURE_PREPARE_DATABASE_URL===env.DATABASE_URL)
  throw fail();
 return Object.freeze({host:HC_SECURE_HOST,database:HC_SECURE_DB});
}
export async function inspectFreshHcSecureDb({environment=process.env,createPool=opts=>new pg.Pool(opts)}={}){
 checkHcSecureDatabaseTarget(environment);
 const pool=createPool({
  connectionString:environment.HC_SECURE_PREPARE_DATABASE_URL,
  max:1,connectionTimeoutMillis:3000,idleTimeoutMillis:1000,
  statement_timeout:3000,application_name:'hc-secure-read-only-preflight'
 });
 let client;
 try{
  client=await pool.connect();
  await client.query('BEGIN READ ONLY');
  const result=await client.query(
   'SELECT current_database() AS db, current_setting(\'transaction_read_only\') AS read_only, '+
   REQUIRED_TABLES.map((_,i)=>'to_regclass($'+(i+1)+'::text) IS NOT NULL AS t'+i).join(', '),
   [...REQUIRED_TABLES]
  );
  await client.query('ROLLBACK');
  const row=result.rows?.[0];
  if(result.rowCount!==1||row?.db!==HC_SECURE_DB||row?.read_only!=='on')
   throw fail();
  const populated=REQUIRED_TABLES.filter((_,i)=>row['t'+i]===true);
  // New database must be fresh; existing schemas require a separate
  // operator-authorized reconciliation instead of re-running bootstrap.
  if(populated.length)throw fail();
  return Object.freeze({fresh:true,requiredTablesAbsent:true,readOnly:true});
 }catch{try{await client?.query('ROLLBACK');}catch{}throw fail();}
 finally{client?.release();await pool.end();}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 inspectFreshHcSecureDb().then(()=>{
  console.log('HC_SECURE_DB_PREFLIGHT_FRESH=true');
 },()=>{
  console.error('HC_SECURE_DB_PREFLIGHT_BLOCKED');
  process.exitCode=1;
 });
}
