import pg from 'pg';
import {validateAdminMigrationTarget} from './admin-schema-isolated-once.mjs';

const ROLE='hc_admin_nav_reader';
const refuse=reason=>{throw new Error('Isolated Admin reader setup refused: '+reason);};
export function validateAdminReaderSetup(env){
 const target=validateAdminMigrationTarget(env);
 if(env.HC_ADMIN_READER_PROVISION_ENABLED!=='true')refuse('missing reader opt-in');
 const password=env.HC_ADMIN_NAV_READER_PASSWORD;
 // Require an independently generated high-entropy secret; no default.
 if(typeof password!=='string'||password.length<48||password.length>200||
    !/^[A-Za-z0-9_-]+$/.test(password))refuse('dedicated reader credential missing or invalid');
 return Object.freeze({...target,role:ROLE});
}
export async function provisionAdminReader({env=process.env,poolFactory=opts=>new pg.Pool(opts)}={}){
 const target=validateAdminReaderSetup(env);
 const pool=poolFactory({
  connectionString:env.HC_ADMIN_SCHEMA_DATABASE_URL,max:1,
  connectionTimeoutMillis:5000,statement_timeout:15000,
  application_name:'hc-isolated-admin-reader-once'
 });
 let client,inTransaction=false;
 try{
  client=await pool.connect();
  await client.query('BEGIN');inTransaction=true;
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query('SELECT pg_advisory_xact_lock(479102, 51)');
  const db=await client.query('SELECT current_database() AS name');
  if(db.rowCount!==1||db.rows[0]?.name!==target.database)refuse('wrong database');
  const schema=await client.query(`SELECT
   to_regclass('public.hc_admin_principals') IS NOT NULL AS principals,
   to_regclass('public.hc_admin_grants') IS NOT NULL AS grants`);
  if(schema.rows[0]?.principals!==true||schema.rows[0]?.grants!==true)
   refuse('canonical Admin grant schema not installed');
  const counts=await client.query(`SELECT
   (SELECT count(*)::integer FROM public.hc_admin_principals) AS owners,
   (SELECT count(*)::integer FROM public.hc_admin_grants) AS grants`);
  if(counts.rows[0]?.owners!==0||counts.rows[0]?.grants!==0)
   refuse('real or synthetic principals already exist; never auto-provision');
  // Creating/modifying this one fixed reader role is the only role mutation.
  // The password is passed as a parameter, not interpolated into SQL or logs.
  await client.query(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hc_admin_nav_reader') THEN
        CREATE ROLE hc_admin_nav_reader NOLOGIN;
      END IF;
    END $$`);
  await client.query('REVOKE ALL ON SCHEMA public FROM hc_admin_nav_reader');
  await client.query('GRANT USAGE ON SCHEMA public TO hc_admin_nav_reader');
  await client.query('REVOKE ALL ON public.hc_admin_principals,public.hc_admin_grants FROM hc_admin_nav_reader');
  await client.query('GRANT SELECT ON public.hc_admin_principals,public.hc_admin_grants TO hc_admin_nav_reader');
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('ALTER ROLE hc_admin_nav_reader SET search_path TO public');
  await client.query("SELECT set_config('hc.admin_reader_secret', $1, true)",[env.HC_ADMIN_NAV_READER_PASSWORD]);
  await client.query(`DO $$
    BEGIN
      EXECUTE format('ALTER ROLE hc_admin_nav_reader LOGIN PASSWORD %L',
        current_setting('hc.admin_reader_secret'));
    END $$`);
  // Role privileges checked by PostgreSQL, not client-supplied claims.
  const privileges=await client.query(`SELECT
    has_table_privilege('hc_admin_nav_reader','public.hc_admin_principals','SELECT') AS principals_read,
    has_table_privilege('hc_admin_nav_reader','public.hc_admin_grants','SELECT') AS grants_read,
    has_table_privilege('hc_admin_nav_reader','public.hc_admin_principals','INSERT,UPDATE,DELETE,TRUNCATE') AS principals_write,
    has_table_privilege('hc_admin_nav_reader','public.hc_admin_grants','INSERT,UPDATE,DELETE,TRUNCATE') AS grants_write,
    has_schema_privilege('hc_admin_nav_reader','public','CREATE') AS can_create`);
  const x=privileges.rows[0];
  if(privileges.rowCount!==1||x?.principals_read!==true||x?.grants_read!==true||
      x?.principals_write!==false||x?.grants_write!==false||x?.can_create!==false)
   refuse('reader privilege verification failed');
  await client.query('COMMIT');inTransaction=false;
  return Object.freeze({readerReady:true,role:ROLE,principals:0,grants:0});
 }catch(error){
  if(inTransaction&&client)await client.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{client?.release();await pool.end();}
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
 provisionAdminReader().then(()=>{
  console.log('Isolated Admin navigation reader provisioned and privilege-checked; no grants or Owner created.');
 }).catch(error=>{console.error(error.message);process.exitCode=1});
}
