import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {assertIsolatedOwnerEnrollmentConfiguration} from './isolated-owner-enrollment.js';

// An idempotent schema creation job for the *isolated* Railway test database.
// It does not migrate any operational Lightspeed or production Timeclock data.
export function assertIsolatedTestDatabase(environment=process.env) {
  if(environment.NODE_ENV!=='test' ||
     environment.HC_SECURITY_ENV!=='isolated-staging' ||
     environment.HC_STAGING_TEST_OWNER_DISCORD_ID!=='115626919134887940' ||
     environment.HC_STAGING_TEST_GUILD_ID!=='1485804234753573066')
    throw new Error('Refusing security migration outside the exact test boundary.');
  let u;
  try{u=new URL(environment.DATABASE_URL);}catch{throw new Error('Test DATABASE_URL missing or invalid.');}
  if(!['postgres:','postgresql:'].includes(u.protocol) ||
     !/^[a-z0-9-]+\.railway\.internal$/i.test(u.hostname)||
     !u.username || !u.password || !u.pathname || u.pathname==='/' ||
     u.search || u.hash)
    throw new Error('Security migration requires the private isolated Railway Postgres URL.');
  return u;
}

export async function migrateIsolatedTestLogin({
 environment=process.env,
 connect=async url=>{
  const client=new pg.Client({connectionString:url,connectionTimeoutMillis:4000});
  await client.connect();
  return client;
 },
 loadSchema=async()=>readFile(new URL('../db/hc_staff_auth_throttle.sql',import.meta.url),'utf8'),
 loadSetupSchema=async()=>readFile(new URL('../db/hc_staging_pin_setup.sql',import.meta.url),'utf8'),
 loadPasskeySchema=async()=>readFile(new URL('../db/hc_staff_passkeys.sql',import.meta.url),'utf8'),
 loadOwnerBootstrapSchema=async()=>readFile(new URL('../db/hc_staging_owner_passkey_bootstrap.sql',import.meta.url),'utf8'),
 loadApprovalSchema=async()=>readFile(new URL('../db/hc_staff_factor_approvals.sql',import.meta.url),'utf8'),
 loadTotpSchema=async()=>readFile(new URL('../db/hc_staff_totp.sql',import.meta.url),'utf8'),
 loadInviteSchema=async()=>readFile(new URL('../db/hc_staff_security_invitations.sql',import.meta.url),'utf8')
}={}){
  assertIsolatedTestDatabase(environment);
  if(environment.HC_STAGING_OWNER_ENROLLMENT_ENABLED==='true')
    assertIsolatedOwnerEnrollmentConfiguration(environment);
  const sql=await loadSchema();
  if(typeof sql!=='string' || !sql.includes('CREATE TABLE IF NOT EXISTS hc_staff_auth_throttle'))
    throw new Error('Invalid isolated throttle migration source.');
  const client=await connect(environment.DATABASE_URL);
  try{
    await client.query('BEGIN');
    await client.query(sql);
    if(environment.HC_STAGING_PIN_STORE_MODE==='database'||environment.HC_STAGING_PIN_SETUP_ENABLED==='true'){
      const setupSql=await loadSetupSchema();
      if(typeof setupSql!=='string'||!setupSql.includes('CREATE TABLE IF NOT EXISTS hc_staging_pin_setup'))
        throw new Error('Invalid one-time PIN setup migration.');
      await client.query(setupSql);
    }
    if(environment.HC_STAGING_OWNER_PASSKEY_ENABLED==='true'){
      if(environment.HC_STAGING_PIN_STORE_MODE!=='database'||
         environment.HC_STAGING_PIN_SETUP_ENABLED!=='false')
        throw new Error('First Owner passkey requires retired PIN setup and persisted PIN.');
      const passkeySql=await loadPasskeySchema();
      const bootstrapSql=await loadOwnerBootstrapSchema();
      if(typeof passkeySql!=='string'||!passkeySql.includes('CREATE TABLE IF NOT EXISTS hc_staff_passkeys')||
         typeof bootstrapSql!=='string'||!bootstrapSql.includes('CREATE TABLE IF NOT EXISTS hc_staging_owner_passkey_bootstrap'))
        throw new Error('Invalid isolated first-Owner WebAuthn schema.');
      await client.query(passkeySql);
      await client.query(bootstrapSql);
    }
    if(environment.HC_STAGING_OWNER_ENROLLMENT_ENABLED==='true'){
      // Never use production data. The exact test-only environment and
      // non-shared secrets were validated before acquiring the connection.
      for(const [load,anchor] of [
        [loadApprovalSchema,'CREATE TABLE IF NOT EXISTS hc_staff_factor_approvals'],
        [loadTotpSchema,'CREATE TABLE IF NOT EXISTS hc_staff_totp'],
        [loadInviteSchema,'CREATE TABLE IF NOT EXISTS hc_staff_security_invitations']
      ]){
        const migration=await load();
        if(typeof migration!=='string'||!migration.includes(anchor))
          throw new Error('Invalid isolated enrollment migration source.');
        await client.query(migration);
      }
    }
    await client.query('COMMIT');
  }catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    throw err;
  }finally{await client.end();}
}

if(process.argv[1] && import.meta.url===new URL('file://'+process.argv[1]).href){
  migrateIsolatedTestLogin().then(
    ()=>console.info('Isolated test login throttle schema verified.'),
    ()=>{console.error('Isolated test login migration failed.');process.exitCode=1;}
  );
}
