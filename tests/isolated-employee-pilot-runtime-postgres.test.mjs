import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {hashIsolatedTestPin} from '../staging/isolated-test-identity.js';
import {assertPilotBootstrapEnvironment}
  from '../scripts/bootstrap-isolated-employee-pilot.mjs';
import {assertIsolatedEmployeePilotRuntime,createIsolatedEmployeePilotApp}
  from '../staging/employee-read-pilot-server.js';

const db=process.env.HC_TEST_DATABASE_URL;
const gated={skip:!db?'Requires isolated disposable PostgreSQL hc_test':false};
const project='c528d08e-b835-4b72-95f2-8a05090a2195';
const secret=()=>randomBytes(48).toString('base64url');
const synthetic={
  HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
  HC_STAGING_TEST_GUILD_ID:'1485804234753573066'
};
const flags={
  NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
  HC_PILOT_PROJECT_ID:project,HC_CORE_EMPLOYEE_PILOT_ENABLED:'true',
  HC_PILOT_BOOTSTRAP_ENABLED:'false',
  HC_STAGING_TEST_LOGIN_ENABLED:'true',HC_PUBLIC_BASE_PATH:'/HobbyCorner',
  HC_CORE_SECURITY_STAGING_ENABLED:'false',
  SPECIAL_ORDERS_LIVE_MODE:'false',SPECIAL_ORDERS_ALLOW_MIGRATION:'false',
  SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES:'false',SCANNER_ENABLED:'false',
  SCANNER_TEST_CREATION_ENABLED:'false',HC_ADMIN_NAV_ENABLED:'false',
  HC_PILOT_DB_HOST:'postgres.railway.internal',HC_PILOT_DB_NAME:'railway',
  HC_PILOT_PUBLIC_ORIGIN:'https://hc-pilot-fixture.up.railway.app',
  ...synthetic
};
const runtimeEnv=()=>({
  ...flags,HC_PILOT_AUTH_PASSWORD:secret(),HC_PILOT_READ_PASSWORD:secret(),
  HC_STAGING_SESSION_SECRET:secret(),HC_STAGING_THROTTLE_SECRET:secret(),
  HC_PILOT_STATION_SIGNING_SECRET:secret(),HC_PILOT_OPERATOR_KEY:secret(),
  HC_STAGING_TEST_PIN_HASH:hashIsolatedTestPin('4821',randomBytes(16))
});
function assertLocal(dbUrl){
  const url=new URL(dbUrl);
  if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/hc_test')
    throw Error('Refusing non-disposable database.');
  return url;
}
test('bootstrap and runtime reject production, real secrets and retained database administrator credentials',()=>{
 const url='postgresql://postgres:fixture@postgres.railway.internal:5432/railway';
 const good={...flags,HC_PILOT_BOOTSTRAP_ENABLED:'true',DATABASE_URL:url,
   HC_PILOT_AUTH_PASSWORD:secret(),HC_PILOT_READ_PASSWORD:secret()};
 assert.doesNotThrow(()=>assertPilotBootstrapEnvironment(good));
 for(const bad of [
   {HC_PILOT_PROJECT_ID:'different'},{NODE_ENV:'production'},
   {HC_SECURITY_ENV:'production'},{HC_PILOT_BOOTSTRAP_ENABLED:'false'},
   {DATABASE_URL:'postgres://postgres:pass@public.example:5432/railway'}
 ])assert.throws(()=>assertPilotBootstrapEnvironment({...good,...bad}));
 const runtime=runtimeEnv();
 assert.doesNotThrow(()=>assertIsolatedEmployeePilotRuntime(runtime));
 for(const bad of [
   {DATABASE_URL:url},{NODE_ENV:'staging'},{HC_PILOT_BOOTSTRAP_ENABLED:'true'},
   {HC_CORE_SECURITY_STAGING_ENABLED:'true'},{SPECIAL_ORDERS_LIVE_MODE:'true'},
   {LIGHTSPEED_TOKEN:'vendor'},{HC_OWNER_STAGING_DATABASE_URL:url},
   {HC_PILOT_AUTH_PASSWORD:runtime.HC_PILOT_READ_PASSWORD},
   {HC_PILOT_PUBLIC_ORIGIN:'https://evil.example'},
   {HC_PILOT_DB_HOST:'real-production-db.railway.external'}
 ])assert.throws(()=>assertIsolatedEmployeePilotRuntime({...runtime,...bad}));
});
test('separate roles, real signed device proof and one-time operator setup work only for synthetic fixtures',
  gated,async()=>{
    const url=assertLocal(db),admin=new pg.Pool({connectionString:url.toString(),max:5});
    const env=runtimeEnv(),authUser='hc_pilot_auth_runtime',readUser='hc_pilot_grants_reader';
    let authPool=null,readerPool=null,server=null;
    try{
      for(const file of ['hc_staff_auth_throttle.sql','hc_staff_stations.sql','hc_core_employee_pilot_grants.sql']){
        await admin.query(await fs.readFile(new URL('../db/'+file,import.meta.url),'utf8'));
      }
      await admin.query(`CREATE TABLE IF NOT EXISTS public.hc_pilot_device_registration (
        id smallint PRIMARY KEY CHECK(id=1),consumed_at timestamptz,device_id uuid UNIQUE)`);
      await admin.query('INSERT INTO public.hc_pilot_device_registration(id) VALUES(1) ON CONFLICT DO NOTHING');
      for(const [user,password] of [[authUser,env.HC_PILOT_AUTH_PASSWORD],[readUser,env.HC_PILOT_READ_PASSWORD]]){
        await admin.query('CREATE ROLE '+user+" LOGIN PASSWORD '"+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE");
      }
      await admin.query('GRANT USAGE ON SCHEMA public TO '+authUser+','+readUser);
      for(const table of ['hc_staff_auth_throttle','hc_staff_stations','hc_staff_station_challenges']){
        await admin.query('GRANT SELECT,INSERT,UPDATE ON public.'+table+' TO '+authUser);
      }
      await admin.query('GRANT SELECT,INSERT ON public.hc_staff_station_events TO '+authUser);
      await admin.query('GRANT SELECT,UPDATE(consumed_at,device_id) ON public.hc_pilot_device_registration TO '+authUser);
      await admin.query('GRANT SELECT ON public.hc_core_employee_pilot_grants TO '+readUser);
      const urlFor=(user,password)=>{
        const u=new URL(url.toString());u.username=user;u.password=password;
        return u.toString();
      };
      authPool=new pg.Pool({connectionString:urlFor(authUser,env.HC_PILOT_AUTH_PASSWORD),max:5});
      readerPool=new pg.Pool({connectionString:urlFor(readUser,env.HC_PILOT_READ_PASSWORD),max:5});
      assert.equal((await authPool.query(
        "SELECT has_table_privilege(current_user,'public.hc_core_employee_pilot_grants','SELECT') AS can_read"
      )).rows[0].can_read,false);
      assert.equal((await readerPool.query(
        "SELECT has_table_privilege(current_user,'public.hc_core_employee_pilot_grants','INSERT,UPDATE,DELETE,TRUNCATE') AS can_write"
      )).rows[0].can_write,false);
      await assert.rejects(readerPool.query(
        "INSERT INTO public.hc_core_employee_pilot_grants(employee_id,operation,approved_by,expires_at) VALUES(901,'special-orders.read',900,now()+interval '1 hour')"
      ),e=>e?.code==='42501');

      const app=await createIsolatedEmployeePilotApp({
        environment:env,authPool,readerPool
      });
      server=await new Promise(resolve=>{
        const s=app.listen(0,'127.0.0.1',()=>resolve(s));
      });
      const origin='http://127.0.0.1:'+server.address().port;
      const fetchPath=(path,{method='GET',headers={},body}={})=>fetch(origin+path,{
        method,redirect:'manual',
        headers:{...(body?{'content-type':'application/json'}:{}),...headers},
        ...(body?{body:JSON.stringify(body)}:{}),
        signal:AbortSignal.timeout(8000)
      });
      const json=async(path,options)=>{
        const r=await fetchPath(path,options);
        return {status:r.status,body:await r.json(),headers:r.headers};
      };
      const head=await fetchPath('/HobbyCorner/');
      assert.equal(head.status,200);
      assert.match(head.headers.get('content-security-policy'),/default-src 'none'/);
      assert.match(await head.text(),/Synthetic employee/i);
      const health=await json('/health');
      assert.equal(health.body.liveBusinessData,false);
      assert.equal((await fetchPath('/HobbyCorner/pilot.js')).status,200);
      assert.equal((await fetchPath('/HobbyCorner/pilot.css')).status,200);
      assert.equal((await json('/HobbyCorner/api/special-orders/orders')).status,403);
      assert.equal((await json('/HobbyCorner/api/admin/navigation-access')).status,403);
      assert.equal((await json('/HobbyCorner/api/pilot/register-station',{
        method:'POST',body:{publicKeySpki:'not-a-key',label:'test'}
      })).status,403);
      assert.equal((await json('/HobbyCorner/api/staff-auth/session',{
        method:'POST',body:{pin:'0000'}
      })).status,401);
      const login=await json('/HobbyCorner/api/staff-auth/session',{
        method:'POST',body:{pin:'4821'}
      });
      assert.equal(login.status,200);
      assert.equal(login.body.employee.permissionSource,'synthetic_staging_only');
      const auth={authorization:'Bearer '+login.body.token};
      const {privateKey,publicKey}=generateKeyPairSync('ed25519');
      const spki=publicKey.export({type:'spki',format:'der'}).toString('base64url');
      const registerBody={publicKeySpki:spki,label:'Local disposable station'};
      const invalidKey=await json('/HobbyCorner/api/pilot/register-station',{
        method:'POST',headers:{...auth,origin:env.HC_PILOT_PUBLIC_ORIGIN,
          'x-hc-pilot-operator-key':'invalid'},body:registerBody
      });
      assert.equal(invalidKey.status,403);
      const registered=await json('/HobbyCorner/api/pilot/register-station',{
        method:'POST',headers:{...auth,origin:env.HC_PILOT_PUBLIC_ORIGIN,
          'x-hc-pilot-operator-key':env.HC_PILOT_OPERATOR_KEY},body:registerBody
      });
      assert.equal(registered.status,200);
      const repeated=await json('/HobbyCorner/api/pilot/register-station',{
        method:'POST',headers:{...auth,origin:env.HC_PILOT_PUBLIC_ORIGIN,
          'x-hc-pilot-operator-key':env.HC_PILOT_OPERATOR_KEY},body:registerBody
      });
      assert.equal(repeated.status,403,'Operator key is one-use');
      const challenge=await json('/HobbyCorner/staff-station/challenge',{
        method:'POST',headers:auth,body:{deviceId:registered.body.deviceId}
      });
      assert.equal(challenge.status,200);
      const payload=Buffer.from('hc:staff:station:v1:'+
        challenge.body.challengeId+':'+challenge.body.challenge);
      const signature=sign(null,payload,privateKey).toString('base64url');
      const proof=await json('/HobbyCorner/staff-station/verify',{
        method:'POST',headers:auth,
        body:{challengeId:challenge.body.challengeId,signature}
      });
      assert.equal(proof.status,200);
      const repeatProof=await json('/HobbyCorner/staff-station/verify',{
        method:'POST',headers:auth,
        body:{challengeId:challenge.body.challengeId,signature}
      });
      assert.equal(repeatProof.status,403,'Signed challenge cannot replay');
      const secured={...auth,'x-hc-station-proof':proof.body.token};
      assert.equal((await json('/HobbyCorner/api/special-orders/orders',{headers:secured})).status,403,
        'No grant: no read');
      await admin.query(`INSERT INTO public.hc_core_employee_pilot_grants
        (employee_id,operation,approved_by,expires_at)
        VALUES(901,'special-orders.read',900,now()+interval '1 hour')`);
      const orders=await json('/HobbyCorner/api/special-orders/orders',{headers:secured});
      assert.equal(orders.status,200);
      assert.deepEqual(orders.body,{synthetic:true,readOnly:true,orders:[]});
      const stats=await json('/HobbyCorner/api/special-orders/stats',{headers:secured});
      assert.equal(stats.status,200);
      assert.equal(stats.body.open,0);
      assert.equal((await json('/HobbyCorner/api/special-orders/orders',{
        method:'POST',headers:secured,body:{}
      })).status,403);
      assert.equal((await json('/HobbyCorner/api/special-orders/orders',{
        headers:{...secured,authorization:'Bearer nonsense','x-hc-role':'owner'}
      })).status,403);
      const second=await json('/HobbyCorner/api/staff-auth/session',{
        method:'POST',body:{pin:'4821'}
      });
      assert.equal(second.status,200);
      assert.equal((await json('/HobbyCorner/api/special-orders/orders',{
        headers:{authorization:'Bearer '+second.body.token,
          'x-hc-station-proof':proof.body.token}
      })).status,403,'Rotated session cannot use old station token');
      await admin.query("UPDATE public.hc_core_employee_pilot_grants SET revoked_at=now() WHERE employee_id=901");
      assert.equal((await json('/HobbyCorner/api/special-orders/orders',{headers:secured})).status,403,
        'Revoked exact DB grant denies even with valid bearer and device proof');
      assert.equal((await json('/HobbyCorner/unknown')).status,404);
    }finally{
      if(server)await new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);});
      if(authPool)await authPool.end();
      if(readerPool)await readerPool.end();
      for(const role of [authUser,readUser]){
        await admin.query('DROP OWNED BY '+role).catch(()=>{});
        await admin.query('DROP ROLE '+role).catch(()=>{});
      }
      await admin.end();
    }
  });
