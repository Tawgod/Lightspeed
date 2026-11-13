import pg from 'pg';
import {readFile} from 'node:fs/promises';

// ONE-TIME operator bootstrap. Run only in the NEW isolated test project with
// a private PostgreSQL administrator URL, then REMOVE that URL before the
// public runtime is deployed. Never mount this file as an HTTP endpoint.
const PROJECT_ID='c528d08e-b835-4b72-95f2-8a05090a2195';
const ROLE_AUTH='hc_pilot_auth_runtime';
const ROLE_READ='hc_pilot_grants_reader';
const SECRET=/^[A-Za-z0-9_-]{43,128}$/;
const ROLE_PROVISION=/^hc_pilot_(?:auth_runtime|grants_reader)$/;

export function assertPilotBootstrapEnvironment(env){
  if(env.NODE_ENV!=='test'||env.HC_SECURITY_ENV!=='isolated-staging'||
     env.HC_CORE_EMPLOYEE_PILOT_ENABLED!=='true'||
     env.HC_PILOT_BOOTSTRAP_ENABLED!=='true'||
     env.HC_PILOT_PROJECT_ID!==PROJECT_ID||
     env.HC_STAGING_TEST_LOGIN_ENABLED!=='true')
    throw new Error('Refusing non-isolated employee pilot bootstrap.');
  for(const key of ['HC_PILOT_AUTH_PASSWORD','HC_PILOT_READ_PASSWORD'])
    if(!SECRET.test(String(env[key]||'')))
      throw new Error('Pilot bootstrap requires independent strong role secrets.');
  if(env.HC_PILOT_AUTH_PASSWORD===env.HC_PILOT_READ_PASSWORD)
    throw new Error('Pilot auth and permission reader roles require different secrets.');
  const url=new URL(env.DATABASE_URL);
  if(!/^postgres(?:ql)?:$/.test(url.protocol)||
     !url.hostname.endsWith('.railway.internal')||
     url.pathname!=='/railway'||url.port && url.port!=='5432')
    throw new Error('Pilot bootstrap requires the new private Railway PostgreSQL connection.');
}

async function executeBootstrap({env=process.env,Pool=pg.Pool}={}){
  assertPilotBootstrapEnvironment(env);
  const pool=new Pool({connectionString:env.DATABASE_URL,max:2,
    connectionTimeoutMillis:8000});
  let client=null;
  try{
    client=await pool.connect();
    const check=await client.query(
      "SELECT to_regclass('public.special_orders') AS orders,"+
      "to_regclass('public.hc_admin_principals') AS admin,"+
      "to_regclass('public.hc_owner_commissioning_authorizations') AS owner");
    if(check.rows?.[0]?.orders||check.rows?.[0]?.admin||check.rows?.[0]?.owner)
      throw new Error('Refusing a database that contains real Hobby Corner schemas.');
    await client.query('BEGIN');
    for(const name of [
      'hc_staff_auth_throttle.sql','hc_staff_stations.sql',
      'hc_core_employee_pilot_grants.sql'
    ]){
      const sql=await readFile(new URL('../db/'+name,import.meta.url),'utf8');
      await client.query(sql);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS public.hc_pilot_device_registration (
      id SMALLINT PRIMARY KEY CHECK(id=1),
      consumed_at TIMESTAMPTZ,
      device_id UUID UNIQUE
    )`);
    await client.query('INSERT INTO public.hc_pilot_device_registration(id) VALUES(1) ON CONFLICT DO NOTHING');
    for(const [name,secret] of [
      [ROLE_AUTH,env.HC_PILOT_AUTH_PASSWORD],
      [ROLE_READ,env.HC_PILOT_READ_PASSWORD]
    ]){
      if(!ROLE_PROVISION.test(name))throw new Error('Invalid bootstrap role.');
      const got=await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name]);
      if(got.rowCount!==0){
        // Fail closed rather than resetting credentials or accidentally
        // reviving a role with privileges from an older environment.
        throw new Error('Pilot role already exists: operator review required.');
      }
      // Role and password characters are restricted above; no SQL injection.
      await client.query('CREATE ROLE '+name+" LOGIN PASSWORD '"+secret+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION");
    }
    await client.query('GRANT USAGE ON SCHEMA public TO '+ROLE_AUTH+','+ROLE_READ);
    await client.query('GRANT SELECT,INSERT,UPDATE ON public.hc_staff_auth_throttle TO '+ROLE_AUTH);
    await client.query('GRANT SELECT,INSERT,UPDATE ON public.hc_staff_stations TO '+ROLE_AUTH);
    await client.query('GRANT SELECT,INSERT,UPDATE ON public.hc_staff_station_challenges TO '+ROLE_AUTH);
    await client.query('GRANT SELECT,INSERT ON public.hc_staff_station_events TO '+ROLE_AUTH);
    await client.query('GRANT SELECT,UPDATE(consumed_at,device_id) ON public.hc_pilot_device_registration TO '+ROLE_AUTH);
    await client.query('GRANT SELECT ON public.hc_core_employee_pilot_grants TO '+ROLE_READ);
    // The operator personally approved creating only a synthetic read-only
    // fixture grant. Existing rows never get refreshed by redeploy.
    await client.query(`INSERT INTO public.hc_core_employee_pilot_grants
      (employee_id,operation,approved_by,expires_at)
      VALUES (901,'special-orders.read',900,now()+interval '23 hours')
      ON CONFLICT DO NOTHING`);
    await client.query('COMMIT');
    return {bootstrapped:true};
  }catch(error){
    if(client)await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{
    client?.release();
    await pool.end();
  }
}

export {executeBootstrap};

if(import.meta.url===new URL('file://'+process.argv[1]).href){
  executeBootstrap().then(()=>console.log('Isolated employee pilot schema and restricted roles provisioned.'))
    .catch(()=>{console.error('Isolated employee pilot bootstrap refused or failed.');process.exitCode=1;});
}
