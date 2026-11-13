import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {createStaffAuthGateway} from '../services/staffAuthGateway.js';
import {createIsolatedTestIdentity,hashIsolatedTestPin}
  from '../staging/isolated-test-identity.js';
import {createPostgresStaffLoginThrottle}
  from '../services/security/staffLoginThrottle.js';
import {createPostgresStaffWorkstations}
  from '../services/security/staffWorkstationsPostgres.js';
import {createStaffStationProofRouter} from '../routes/staffStationProof.js';
import {createCoreEmployeePilotGrantReader}
  from '../services/security/coreEmployeePilotGrantReader.js';
import {createIsolatedCoreEmployeeReadPilot}
  from '../services/security/coreOperationsIsolatedReadPilot.js';

const db=process.env.HC_TEST_DATABASE_URL;
const testEnv=Object.freeze({
  NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
  HC_PUBLIC_BASE_PATH:'/HobbyCorner',
  HC_CORE_EMPLOYEE_PILOT_ENABLED:'true',
  HC_STAGING_TEST_LOGIN_ENABLED:'true',
  HC_CORE_SECURITY_STAGING_ENABLED:'false',
  SPECIAL_ORDERS_LIVE_MODE:'false',SPECIAL_ORDERS_ALLOW_MIGRATION:'false',
  SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES:'false',
  SCANNER_ENABLED:'false',SCANNER_TEST_CREATION_ENABLED:'false',
  HC_ADMIN_NAV_ENABLED:'false'
});
const denied=e=>e?.status===403&&e?.code==='HC_CORE_OPERATIONS_FORBIDDEN';
function assertDisposableDatabase(connection){
  const url=new URL(connection);
  if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost')
    throw Error('Pilot test refuses a non-loopback PostgreSQL host');
  if(url.pathname!=='/hc_test')
    throw Error('Pilot test refuses any database except hc_test');
  return url;
}
function testRequests(url){
  const request=(path,{method='GET',headers={},body}={})=>fetch(url+path,{
    method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},
    ...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(10000)
  });
  return {get:async(path,headers={})=>request(path,{headers}),
    post:async(path,body,headers={})=>request(path,{method:'POST',body,headers})};
}

test('pilot refuses real staging/production, vendor credentials, missing factors and broad DB roles',async()=>{
  const fakeGateway={verifyBoundEmployee:async()=>({})};
  const fakeStations={verifyWorkstation:async()=>null};
  const fakeReader={verifyReadOnly:async()=>true,checkPermission:async()=>false};
  const options={environment:testEnv,staffAuthGateway:fakeGateway,
    workstations:fakeStations,grantReader:fakeReader};
  for(const changed of [
    {NODE_ENV:'production'},{NODE_ENV:'staging'},
    {HC_SECURITY_ENV:'test'},{HC_CORE_EMPLOYEE_PILOT_ENABLED:'false'},
    {HC_STAGING_TEST_LOGIN_ENABLED:'false'},
    {HC_CORE_SECURITY_STAGING_ENABLED:'true'},
    {HC_PUBLIC_BASE_PATH:'/'},{SPECIAL_ORDERS_LIVE_MODE:'true'},
    {SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES:'true'},
    {LIGHTSPEED_TOKEN:'live'},{DISCORD_TOKEN:'live'},
    {HC_OWNER_TIMECLOCK_SERVICE_SECRET:'live'}
  ]){
    await assert.rejects(createIsolatedCoreEmployeeReadPilot({
      ...options,environment:{...testEnv,...changed}
    }),/independent, credential-free isolated/);
  }
  await assert.rejects(createIsolatedCoreEmployeeReadPilot({
    ...options,grantReader:{...fakeReader,verifyReadOnly:async()=>false}
  }),/SELECT-only/);
  await assert.rejects(createIsolatedCoreEmployeeReadPilot({
    ...options,workstations:null
  }),TypeError);
  assert.throws(()=>createCoreEmployeePilotGrantReader(),TypeError);
  const gate=await createIsolatedCoreEmployeeReadPilot(options);
  await assert.rejects(gate.authorize({request:{method:'POST',path:'/orders'}}),denied);
});

test('real signed test PIN + real Ed25519 station + PostgreSQL SELECT-only exact grant authorizes ONLY synthetic reads',
  {skip:!db?'Requires the disposable hc_test PostgreSQL from CI':false},
  async()=>{
    const dsn=assertDisposableDatabase(db);
    const operator=new pg.Pool({connectionString:db,max:5});
    let readerPool=null,server=null,role=null;
    try{
      for(const file of [
        'hc_staff_auth_throttle.sql','hc_staff_stations.sql',
        'hc_core_employee_pilot_grants.sql'
      ]){
        await operator.query(await fs.readFile(
          new URL('../db/'+file,import.meta.url),'utf8'));
      }
      // Create a separate principal for the running service. Its password is
      // generated only in the disposable CI process, never stored in source.
      role='hc_pilot_reader_'+randomBytes(5).toString('hex');
      assert.match(role,/^hc_pilot_reader_[a-f0-9]{10}$/);
      const password=randomBytes(32).toString('base64url');
      await operator.query('CREATE ROLE '+role+" LOGIN PASSWORD '"+password+"'");
      await operator.query('GRANT USAGE ON SCHEMA public TO '+role);
      await operator.query('GRANT SELECT ON public.hc_core_employee_pilot_grants TO '+role);
      const restricted=new URL(dsn.toString());
      restricted.username=role;restricted.password=password;
      readerPool=new pg.Pool({connectionString:restricted.toString(),max:4});
      const reader=createCoreEmployeePilotGrantReader({pool:readerPool});
      const privileged=createCoreEmployeePilotGrantReader({pool:operator});
      assert.equal(await privileged.verifyReadOnly(),false,'Operator DB credential cannot serve read API');
      assert.equal(await reader.verifyReadOnly(),true);
      await assert.rejects(
        readerPool.query("UPDATE public.hc_core_employee_pilot_grants SET revoked_at=now()"),
        e=>e?.code==='42501','DB prevents runtime mutation');
      assert.equal(await reader.checkPermission({
        identity:{id:'901',active:true},operation:'special-orders.read'
      }),false,'New pilot starts without a permission grant');

      const {publicKey,privateKey}=generateKeyPairSync('ed25519');
      const PIN='4821'; // disposable test only; never a real Timeclock PIN
      const identity=createIsolatedTestIdentity({
        environment:{...testEnv,
          HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
          HC_STAGING_TEST_GUILD_ID:'1485804234753573066'},
        passwordHash:hashIsolatedTestPin(PIN,randomBytes(16))
      });
      const loginLimiter=createPostgresStaffLoginThrottle({
        pool:operator,scope:'hc:employee-pilot:pin',
        secret:randomBytes(48).toString('hex')
      });
      const gateway=createStaffAuthGateway({
        identity,sessionSecret:randomBytes(48).toString('hex'),
        loginLimiter:({ip})=>loginLimiter.reserve({employeeId:'901',sourceIp:ip})
      });
      const manager=Object.freeze({approved:true});
      const stationLimiter=createPostgresStaffLoginThrottle({
        pool:operator,scope:'hc:employee-pilot:station',
        secret:randomBytes(48).toString('hex')
      });
      const workstations=createPostgresStaffWorkstations({
        pool:operator,signingSecret:randomBytes(48).toString('hex'),
        loginThrottle:stationLimiter,
        verifyEmployeeSession:req=>gateway.verifyBoundEmployee(req),
        verifyStrongManager:async ctx=>ctx===manager?{
          id:900,active:true,method:'passkey',authenticatedAtMs:Date.now()-1000
        }:null,
        canManage:async({approverId,operation})=>approverId==='900'&&
          ['staff.workstation.register','staff.workstation.revoke'].includes(operation)
      });
      // Simulated independent manager only exists in this Node process, and
      // is NEVER installed as a public HTTP endpoint or real Owner bootstrap.
      const {deviceId}=await workstations.register({
        context:manager,
        publicKeySpki:publicKey.export({format:'der',type:'spki'}).toString('base64url'),
        label:'Disposable Ed25519 test station'
      });
      const pilot=await createIsolatedCoreEmployeeReadPilot({
        environment:testEnv,staffAuthGateway:gateway,workstations,grantReader:reader
      });

      const app=express(),reached=[];
      app.use('/api/staff-auth',gateway.router);
      app.use('/staff-station',createStaffStationProofRouter({workstations}));
      app.use('/api/special-orders',pilot.middleware);
      for(const [route,method] of [['/orders','GET'],['/stats','GET'],['/orders','POST']]){
        app[method.toLowerCase()]('/api/special-orders'+route,(req,res)=>{
          reached.push(method+' '+route);
          res.set('Cache-Control','no-store').json({fixture:true,items:[]});
        });
      }
      server=await new Promise(resolve=>{
        const s=app.listen(0,'127.0.0.1',()=>resolve(s));
      });
      const {get,post}=testRequests('http://127.0.0.1:'+server.address().port);
      const wrong=await post('/api/staff-auth/session',{pin:'1111'});
      assert.equal(wrong.status,401);
      const login=await post('/api/staff-auth/session',{pin:PIN});
      assert.equal(login.status,200);
      const {token}=await login.json();
      const auth={authorization:'Bearer '+token};
      const unsigned=await get('/api/special-orders/orders',{'x-hc-role':'owner'});
      assert.equal(unsigned.status,403);
      assert.equal((await get('/api/special-orders/orders',auth)).status,403);
      const forged=await get('/api/special-orders/orders',{
        ...auth,'x-hc-role':'owner','x-hc-station-proof':'verified'
      });
      assert.equal(forged.status,403);

      const challengeRes=await post('/staff-station/challenge',{deviceId},auth);
      assert.equal(challengeRes.status,200);
      const challenge=await challengeRes.json();
      const signed=sign(null,Buffer.from('hc:staff:station:v1:'+
        challenge.challengeId+':'+challenge.challenge),privateKey).toString('base64url');
      const proofRes=await post('/staff-station/verify',{
        challengeId:challenge.challengeId,signature:signed
      },auth);
      assert.equal(proofRes.status,200);
      const {token:stationToken}=await proofRes.json();
      assert.equal((await post('/staff-station/verify',{
        challengeId:challenge.challengeId,signature:signed
      },auth)).status,403,'Station challenge can only be consumed once');
      const signedHeaders={...auth,'x-hc-station-proof':stationToken};
      assert.equal((await get('/api/special-orders/orders',signedHeaders)).status,403,
        'Signed session plus real station alone has no implicit operation grant');

      // Test operator provisions exactly one expiring, individually approved
      // test-only read grant. The running reader has NO write capability.
      await operator.query(`INSERT INTO public.hc_core_employee_pilot_grants
        (employee_id,operation,approved_by,expires_at)
        VALUES(901,'special-orders.read',900,now()+interval '1 hour')`);
      assert.equal((await get('/api/special-orders/orders',signedHeaders)).status,200);
      assert.equal((await get('/api/special-orders/stats',signedHeaders)).status,200);
      assert.equal((await post('/api/special-orders/orders',{},signedHeaders)).status,403,
        'Read grant can never admit an order write');
      assert.deepEqual(reached,['GET /orders','GET /stats']);
      // An unregistered service or Owner claim cannot use the read route.
      assert.equal((await get('/api/special-orders/orders',{
        'x-hc-role':'owner','x-hc-employee-id':'901'
      })).status,403);
      const anotherLogin=await post('/api/staff-auth/session',{pin:PIN});
      const anotherToken=(await anotherLogin.json()).token;
      assert.equal((await get('/api/special-orders/orders',{
        authorization:'Bearer '+anotherToken,'x-hc-station-proof':stationToken
      })).status,403,'Station proof cannot cross signed session rotation');

      await operator.query(`UPDATE public.hc_core_employee_pilot_grants
        SET revoked_at=now() WHERE employee_id=901 AND operation='special-orders.read'`);
      assert.equal((await get('/api/special-orders/orders',signedHeaders)).status,403,
        'Revoking the durable grant immediately denies existing session/station');
      assert.deepEqual(reached,['GET /orders','GET /stats']);
      assert.equal(await reader.checkPermission({identity:{id:'902',active:true},
        operation:'special-orders.read'}),false);
      assert.equal(await reader.checkPermission({identity:{id:'901',active:true},
        operation:'special-orders.manage'}),false);
    }finally{
      if(server)await new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);});
      if(readerPool)await readerPool.end();
      if(role){
        await operator.query('REVOKE SELECT ON public.hc_core_employee_pilot_grants FROM '+role).catch(()=>{});
        await operator.query('REVOKE USAGE ON SCHEMA public FROM '+role).catch(()=>{});
        await operator.query('DROP ROLE '+role).catch(()=>{});
      }
      await operator.end();
    }
  });
