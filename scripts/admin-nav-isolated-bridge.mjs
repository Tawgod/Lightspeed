import express from 'express';
import pg from 'pg';
import {createScannerSessions} from '../services/scannerSessions.js';
import {createTimeclockScannerIdentity} from '../services/scannerTimeclockIdentity.js';
import {createAdminNavigationAccessRouter,createAdminNavigationGrantReader,verifyAdminNavigationReadOnlyDatabase} from '../services/security/adminNavigationAccess.js';

// Dedicated test-only service; never copies production Timeclock credentials.
// Admin link visibility is a hint, NOT step-up MFA or Admin authorization.
const fail=()=>{throw new Error('Isolated Admin navigation bridge configuration rejected.');};
export function validateIsolatedNavBridge(env){
 if(env.HC_NAV_BRIDGE_TEST_ENABLED!=='true'||env.HC_NAV_BRIDGE_ENVIRONMENT!=='test'||
    env.HC_NAV_BRIDGE_TARGET!=='Postgres-O39p'||
    env.RAILWAY_ENVIRONMENT_NAME && env.RAILWAY_ENVIRONMENT_NAME!=='test')fail();
 const host=env.HC_NAV_BRIDGE_DB_HOST,db=env.HC_NAV_BRIDGE_DB_NAME;
 if(typeof host!=='string'||!host.endsWith('.railway.internal')||
    typeof db!=='string'||!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(db)||
    typeof env.HC_ADMIN_NAV_READER_PASSWORD!=='string'||
    env.HC_ADMIN_NAV_READER_PASSWORD.length<48)fail();
 const origin=env.HC_NAV_BRIDGE_TIMECLOCK_ORIGIN;
 const serviceSecret=env.HC_NAV_BRIDGE_TIMECLOCK_SECRET;
 const sessionSecret=env.HC_NAV_BRIDGE_SESSION_SECRET;
 const configured=[origin,serviceSecret,sessionSecret].map(x=>typeof x==='string'&&x.length>0);
 if(configured.some(Boolean)&&!configured.every(Boolean))fail();
 if(configured.every(Boolean) && (serviceSecret.length<32||sessionSecret.length<32))fail();
 const port=Number(env.PORT||3000);
 if(!Number.isSafeInteger(port)||port<1||port>65535)fail();
 return Object.freeze({
  host,database:db,port,
  identityReady:configured.every(Boolean),
  origin,serviceSecret,sessionSecret
 });
}
export async function createIsolatedNavBridge({
 env=process.env, poolFactory=opts=>new pg.Pool(opts),
 identityFactory=opts=>createTimeclockScannerIdentity(opts),
 sessionFactory=opts=>createScannerSessions(opts)
}={}){
 const config=validateIsolatedNavBridge(env);
 const pool=poolFactory({
  host:config.host,database:config.database,user:'hc_admin_nav_reader',
  password:env.HC_ADMIN_NAV_READER_PASSWORD,port:5432,max:2,
  connectionTimeoutMillis:4000,statement_timeout:4000,
  application_name:'hc-isolated-admin-nav-bridge'
 });
 try{
  const identity=await pool.query('SELECT current_database() AS name,current_user AS login');
  if(identity.rowCount!==1||identity.rows[0]?.name!==config.database||
     identity.rows[0]?.login!=='hc_admin_nav_reader')fail();
  if(!await verifyAdminNavigationReadOnlyDatabase({pool}))fail();
  const app=express();
  app.disable('x-powered-by');
  app.use((_req,res,next)=>{
   res.set({'Cache-Control':'no-store, max-age=0','Pragma':'no-cache',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
   next();
  });
  // A private diagnostic contains no identities, grants, credentials, or
  // user data. No public domain is configured in Railway.
  app.get('/health',(_req,res)=>res.json({ok:true,adminGrantsDatabase:'read-only',
    employeeVerifier:config.identityReady?'configured':'disabled'}));
  let verifyEmployee=async()=>{throw Error('Employee verification not configured');};
  if(config.identityReady){
   const sessions=sessionFactory({secret:config.sessionSecret,ttlSeconds:900});
   const timeclock=identityFactory({baseUrl:config.origin,serviceSecret:config.serviceSecret});
   verifyEmployee=async req=>{
    const bearer=req.get('authorization')||'';
    if(!/^Bearer [A-Za-z0-9._~-]+$/.test(bearer))throw Error('No signed session');
    const session=sessions.verify(bearer.slice(7));
    // Server-to-server Timeclock check on every navigation request ensures
    // deactivated employees cannot retain the Admin link.
    const employee=await timeclock.authorize(session.employeeId);
    if(String(employee?.id)!==String(session.employeeId)||
       employee?.permissionSource!=='timeclock_employee')
      throw Error('Active Timeclock employee verification denied');
    return employee;
   };
  }
  const grants=createAdminNavigationGrantReader({pool});
  app.use('/api/admin',createAdminNavigationAccessRouter({
   verifyEmployee,hasAdminRead:grants
  }));
  return Object.freeze({
   app,port:config.port,identityReady:config.identityReady,
   async close(){await pool.end();}
  });
 }catch(error){await pool.end().catch(()=>{});throw error;}
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
 createIsolatedNavBridge().then(async bridge=>{
  const server=bridge.app.listen(bridge.port,'0.0.0.0',()=>{
   console.log('Isolated Admin navigation bridge ready; read-only grants verified; employee validation '+(bridge.identityReady?'configured':'disabled'));
  });
  const stop=()=>server.close(()=>bridge.close().then(()=>process.exit(0)));
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
 }).catch(error=>{console.error(error.message);process.exitCode=1});
}
