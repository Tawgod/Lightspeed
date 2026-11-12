import express from 'express';
import pg from 'pg';
import {validateOwnerStagingDatabaseUrl} from './owner-security-server.js';
import {verifyOwnerStagingDatabasePrivileges} from '../services/security/ownerStagingDatabasePreflight.js';

// No authentication, identity, password input or account activation is mounted.
const P='5b46096d-3178-47ec-ba88-d5037696346a';
const E='46b93c76-3085-4e76-a37d-90dfdd250dd2';
const H='hc-owner-staging-staging.up.railway.app';
const signers=['HC_OWNER_SESSION_SECRET','HC_OWNER_THROTTLE_SECRET',
 'HC_OWNER_PASSKEY_SIGNING_SECRET','HC_OWNER_APPROVAL_HMAC_SECRET',
 'HC_OWNER_MFA_SESSION_SECRET','HC_OWNER_TIMECLOCK_SERVICE_SECRET'];
function refuse(){throw Error('Locked Owner staging preview configuration rejected')}
export function validateOwnerLockedPreviewEnv(env={}){
 if(env.NODE_ENV!=='test'||env.HC_SECURITY_ENV!=='isolated-staging'||
    env.RAILWAY_PROJECT_ID!==P||env.RAILWAY_ENVIRONMENT_ID!==E||
    env.RAILWAY_SERVICE_NAME!=='hc-owner-staging'||
    env.HC_OWNER_STAGING_ENABLED!=='false'||
    env.HC_STAGING_TEST_LOGIN_ENABLED!=='false'||
    env.HC_STAGING_PIN_SETUP_ENABLED!=='false'||
    env.OWNER_STAGING_IDENTITY_ENABLED==='true'||
    env.HC_OWNER_TIMECLOCK_EMPLOYEE_ID||
    env.HC_OWNER_OPERATOR_DATABASE_URL||
    env.HC_OWNER_OPERATOR_ACK)refuse();
 if(env.HC_OWNER_STAGING_ORIGIN!=='https://'+H||env.HC_OWNER_STAGING_RPID!==H)refuse();
 try{validateOwnerStagingDatabaseUrl(env)}catch{refuse()}
 const u=new URL(env.HC_OWNER_STAGING_DATABASE_URL);
 if(u.hostname!=='postgres-x8ui.railway.internal'||
    u.username!=='hc_owner_stage_runtime'||
    u.pathname!=='/hc_owner_stage_test'||
    !/^[A-Za-z0-9]{48}$/.test(u.password))refuse();
 if(signers.some(k=>typeof env[k]!=='string'||!/^[A-Za-z0-9]{48}$/.test(env[k]))||
    new Set(signers.map(k=>env[k])).size!==signers.length)refuse();
 const totp=env.HC_OWNER_TOTP_ENCRYPTION_KEY;
 if(typeof totp!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(totp)||
    Buffer.from(totp,'base64').length!==32)refuse();
 return Object.freeze({dbUrl:env.HC_OWNER_STAGING_DATABASE_URL});
}
const html='<!doctype html><html lang="en"><head><meta charset="utf-8">'+
 '<meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<meta name="referrer" content="no-referrer"><title>Hobby Corner | Owner Setup</title>'+
 '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1c32;color:#eef4ff;font:16px system-ui,Arial,sans-serif}'+
 'main{width:min(550px,calc(100vw - 48px));padding:36px;background:#152c48;border:1px solid #335170;border-radius:18px}'+
 'small{color:#8ec0e2;font-weight:700;letter-spacing:.12em}h1{font-size:32px}p{color:#ccd9e8;line-height:1.7}</style></head>'+
 '<body><main><small>HOBBY CORNER · ACCOUNT SECURITY</small><h1>Owner login setup</h1>'+
 '<p>The private Owner login is being prepared. Sign-in and passkey enrollment are <strong>not enabled</strong> yet.</p>'+
 '<p>Your existing Timeclock PIN and production permissions have not changed.</p></main></body></html>';
export async function prepareLockedOwnerPreview({environment=process.env,
 createPool=opts=>new pg.Pool(opts),verify=verifyOwnerStagingDatabasePrivileges}={}){
 const config=validateOwnerLockedPreviewEnv(environment);
 const pool=createPool({connectionString:config.dbUrl,max:2,connectionTimeoutMillis:4000});
 try{
  await verify({pool});
  const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
  app.use((_req,res,next)=>{
   res.set({'Cache-Control':'no-store, max-age=0','Referrer-Policy':'no-referrer',
   'X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff',
   'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});
   next();
  });
  app.get('/health',(_req,res)=>res.json({service:'owner-security-staging',ready:false,locked:true}));
  app.get(['/','/owner-setup','/owner-setup/'],(_req,res)=>res.type('html').send(html));
  app.all(['/api/staff-auth','/api/staff-auth/*','/owner-setup/*',
   '/staff-passkey','/staff-passkey/*','/staff-security','/staff-security/*'],
   (_req,res)=>res.status(423).json({error:'Owner enrollment not enabled.'}));
  app.use((_req,res)=>res.sendStatus(404));
  return Object.freeze({app,close:()=>pool.end()});
 }catch(error){await pool.end().catch(()=>{});throw error}
}
export async function startLockedOwnerPreview(environment=process.env){
 const state=await prepareLockedOwnerPreview({environment}),port=Number(environment.PORT);
 if(!Number.isInteger(port)||port<1||port>65535){await state.close();throw Error('Port required')}
 const server=state.app.listen(port,'0.0.0.0');
 server.once('close',()=>{void state.close()});
 return server;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 startLockedOwnerPreview().then(()=>console.log('HC_OWNER_PREVIEW_LOCKED ready=false'))
 .catch(()=>{console.error('HC_OWNER_PREVIEW_REFUSED');process.exitCode=1});
}
