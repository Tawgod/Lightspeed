import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import express from 'express';
import {hashIsolatedTestPin} from './isolated-test-identity.js';

const GUARD={owner:'115626919134887940',guild:'1485804234753573066'};
const invalid=()=>Object.assign(new Error('PIN setup not authorized or no longer available.'),{status:403});
const digest=value=>createHash('sha256').update(value,'utf8').digest();
function sameSecret(a,b){
 if(typeof a!=='string'||typeof b!=='string')return false;
 const x=digest(a),y=digest(b);
 return timingSafeEqual(x,y);
}
export function createIsolatedPinSetup({
 environment=process.env,pool
}={}){
 if(environment.NODE_ENV!=='test'||environment.HC_SECURITY_ENV!=='isolated-staging'||
   environment.HC_STAGING_TEST_OWNER_DISCORD_ID!==GUARD.owner||
   environment.HC_STAGING_TEST_GUILD_ID!==GUARD.guild||
   environment.HC_STAGING_TEST_LOGIN_ENABLED!=='true'||
   typeof pool?.connect!=='function')
   throw new Error('PIN setup requires isolated staging identity and database.');
 const origin=environment.HC_STAGING_PUBLIC_ORIGIN||'';
 let url;
 try{url=new URL(origin);}catch{throw new Error('PIN setup requires exact HTTPS test origin.');}
 if(url.protocol!=='https:'||url.origin!==origin||
    url.hostname!=='staff-security-staging-test.up.railway.app')
   throw new Error('PIN setup origin is not the approved test host.');
 // Optional feature flag is fail closed. The admin-supplied secret exists ONLY in
 // Railway variables; it never appears in an HTML response or Git history.
 const enabled=environment.HC_STAGING_PIN_SETUP_ENABLED==='true';
 const bootstrap=enabled?(environment.HC_STAGING_PIN_SETUP_KEY||''):'';
 if(enabled&&(bootstrap.length<43||bootstrap.length>256))
   throw new Error('A separate high-entropy one-time PIN setup key is required.');
 const router=express.Router();
 router.use((req,res,next)=>{
   res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
     'X-Content-Type-Options':'nosniff'});
   next();
 });
 router.post('/set',express.json({strict:true,limit:'1kb'}),async(req,res)=>{
   if(!enabled)return res.status(404).json({error:'PIN setup is disabled.'});
   if(req.get('origin')!==origin||req.get('sec-fetch-site')==='cross-site')
     return res.status(403).json({error:'PIN setup denied.'});
   const body=req.body;
   if(!body||Object.keys(body).sort().join(',')!=='pin,setupKey'||
     typeof body.pin!=='string'||!/^\d{4}$/.test(body.pin)||
     typeof body.setupKey!=='string'||body.setupKey.length>256||
     !sameSecret(body.setupKey,bootstrap))
     return res.status(403).json({error:'PIN setup not authorized or no longer available.'});
   let db;
   try{
     db=await pool.connect();
     await db.query('BEGIN');
     const state=await db.query('SELECT pin_hash,completed_at FROM hc_staging_pin_setup WHERE id=1 FOR UPDATE');
     const row=state.rows?.[0];
     if(!row||row.completed_at)throw invalid();
     const hash=hashIsolatedTestPin(body.pin,randomBytes(16));
     await db.query('UPDATE hc_staging_pin_setup SET pin_hash=$1,completed_at=now() WHERE id=1 AND completed_at IS NULL',[hash]);
     await db.query('COMMIT');
     return res.status(201).json({ok:true,detail:'Test PIN saved. Open /test-login to sign in.'});
   }catch{
     if(db)await db.query('ROLLBACK').catch(()=>{});
     return res.status(403).json({error:'PIN setup not authorized or unavailable.'});
   }finally{db?.release();}
 });
 async function pinHash(){
   const result=await pool.query('SELECT pin_hash FROM hc_staging_pin_setup WHERE id=1');
   const hash=result.rows?.[0]?.pin_hash;
   if(typeof hash!=='string'||!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash))
     throw new Error('Test PIN has not been initialized.');
   return hash;
 }
 return Object.freeze({router,pinHash,enabled});
}
