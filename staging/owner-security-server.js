import express from 'express';
import pg from 'pg';
import {createOwnerTimeclockStagingBundle,validateOwnerTimeclockStagingConfig}
 from '../services/security/ownerTimeclockStagingBundle.js';
import {verifyOwnerStagingDatabasePrivileges}
 from '../services/security/ownerStagingDatabasePreflight.js';

// Separate, explicitly opted-in staging executable. Does not reuse existing
// synthetic staff-security-staging or production server.js, and NEVER performs
// migrations, provisions Owner records or issues activation codes.
export function validateOwnerStagingDatabaseUrl(environment={}){
 const url=environment.HC_OWNER_STAGING_DATABASE_URL;
 let parsed;
 try{parsed=new URL(url);}catch{throw new TypeError('Dedicated Owner staging DB URL required.');}
 if(!['postgres:','postgresql:'].includes(parsed.protocol)||
    parsed.pathname!=='/hc_owner_stage_test'||
    !parsed.hostname||parsed.hash||
    parsed.search||parsed.username===''){
  throw new TypeError('Dedicated hc_owner_stage_test database required.');
 }
 if(environment.DATABASE_URL===url)
  throw new TypeError('Do not reuse the default shared production database URL.');
 return url;
}
export async function prepareOwnerStagingApp({
 environment=process.env,createPool=options=>new pg.Pool(options),
 verifyDatabase=verifyOwnerStagingDatabasePrivileges,
 createBundle=createOwnerTimeclockStagingBundle
}={}){
 const check=validateOwnerTimeclockStagingConfig(environment);
 if(!check.ready)throw new TypeError('Owner staging configuration incomplete: '+check.issues.join(', '));
 const dbUrl=validateOwnerStagingDatabaseUrl(environment);
 const pool=createPool({
  connectionString:dbUrl,max:5,connectionTimeoutMillis:3000,
  idleTimeoutMillis:10000
 });
 if(typeof pool?.connect!=='function'||typeof pool?.end!=='function')
  throw new TypeError('A disposable PostgreSQL connection is required.');
 try{
  await verifyDatabase({pool});
  const bundle=createBundle({environment,pool});
  const app=express();
  app.disable('x-powered-by');
  app.set('trust proxy',false); // Never trust client-supplied forwarding data.
  app.use((_req,res,next)=>{
   res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});
   next();
  });
  // Health reveals no employee identity, configuration or secrets.
  app.get('/health',(_req,res)=>res.json({service:'owner-security-staging',ready:true}));
  bundle.mount(app);
  return Object.freeze({app,close:()=>pool.end()});
 }catch(error){
  await pool.end().catch(()=>{});
  throw error;
 }
}
export async function startOwnerStaging(environment=process.env){
 const setup=await prepareOwnerStagingApp({environment});
 const port=Number(environment.PORT);
 if(!Number.isInteger(port)||port<1||port>65535){
  await setup.close();
  throw new TypeError('Configured server port required.');
 }
 const server=setup.app.listen(port,'0.0.0.0');
 server.once('close',()=>{void setup.close();});
 return server;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 startOwnerStaging().catch(()=>{
  console.error('Owner staging is not safely configured. Server not started.');
  process.exitCode=1;
 });
}
