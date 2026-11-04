import {readFile} from 'node:fs/promises';
import pg from 'pg';

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
 loadSetupSchema=async()=>readFile(new URL('../db/hc_staging_pin_setup.sql',import.meta.url),'utf8')
}={}){
  assertIsolatedTestDatabase(environment);
  const sql=await loadSchema();
  if(typeof sql!=='string' || !sql.includes('CREATE TABLE IF NOT EXISTS hc_staff_auth_throttle'))
    throw new Error('Invalid isolated throttle migration source.');
  const client=await connect(environment.DATABASE_URL);
  try{
    await client.query('BEGIN');
    await client.query(sql);
    if(environment.HC_STAGING_PIN_SETUP_ENABLED==='true'){
      const setupSql=await loadSetupSchema();
      if(typeof setupSql!=='string'||!setupSql.includes('CREATE TABLE IF NOT EXISTS hc_staging_pin_setup'))
        throw new Error('Invalid one-time PIN setup migration.');
      await client.query(setupSql);
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
