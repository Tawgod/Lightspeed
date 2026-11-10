import express from 'express';
import {readFile} from 'node:fs/promises';

// Development candidate only. Must never be mounted without an approved
// operator-selected Timeclock employee, isolated origin, secure runtime session,
// CSRF protection, backend throttling and privilege-separated activation DB.
// The candidate enforces independent operator activation, not a PIN-based grant.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const headers={'Cache-Control':'no-store, max-age=0','Pragma':'no-cache',
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
 'X-Frame-Options':'DENY','Cross-Origin-Resource-Policy':'same-origin'};
const error=(res,e)=>res.status(e?.status===503?503:403).json({
 error:e?.status===503?'Owner setup temporarily unavailable.':
 'Owner setup is not authorized or has expired.'
});
export function createFirstOwnerActivationRouter({candidate,origin}={}){
 if(typeof candidate?.beginRegistration!=='function'||
    typeof candidate?.finishRegistration!=='function')
   throw new TypeError('Verified Owner passkey candidate required.');
 let trusted;
 try{trusted=new URL(origin);}catch{throw new TypeError('Configured HTTPS origin required.');}
 if((trusted.protocol!=='https:'&&trusted.origin!=='http://localhost')||
    trusted.origin!==origin||trusted.username||trusted.password||
    trusted.pathname!=='/'||trusted.search||trusted.hash)
   throw new TypeError('Exact HTTPS or isolated localhost origin required.');
 const router=express.Router();
 router.use((_req,res,next)=>{res.set(headers);next();});
 const denyCrossSite=(req,res,next)=>{
  // Both an exact Origin and an explicit same-origin fetch marker are required
  // for secret-bearing requests; absent/opaque origins must not bypass CSRF.
  if(req.get('origin')!==origin||
     req.get('sec-fetch-site')!=='same-origin'||
     req.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')
   return res.status(403).json({error:'Same-origin Owner setup required.'});
  next();
 };
 const parse=express.json({limit:'24kb',strict:true});
 router.get('/',async(_req,res)=>{
  res.set('Content-Security-Policy',
   "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "+
   "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  try{
   const data=await readFile(new URL('../owner-setup/index.html',import.meta.url));
   return res.type('html').send(data);
  }catch{return res.sendStatus(503);}
 });
 router.get('/styles.css',async(_req,res)=>{
  try{
   const data=await readFile(new URL('../owner-setup/styles.css',import.meta.url));
   return res.type('text/css').send(data);
  }catch{return res.sendStatus(503);}
 });
 router.get('/client.js',async(_req,res)=>{
  try{
   const data=await readFile(new URL('../owner-setup/client.js',import.meta.url));
   return res.type('application/javascript').send(data);
  }catch{return res.sendStatus(503);}
 });
 const activation=(req,res,next)=>{
  if(!TOKEN.test(req.get('x-hc-owner-activation')||''))
   return res.status(403).json({error:'Valid activation required.'});
  next();
 };
 router.post('/registration/options',denyCrossSite,activation,parse,async(req,res)=>{
  if(!req.body||Object.keys(req.body).length!==0)
   return res.status(400).json({error:'Invalid request.'});
  try{return res.json(await candidate.beginRegistration({
   context:req,sourceIp:req.ip
  }));}catch(e){return error(res,e);}
 });
 router.post('/registration/verify',denyCrossSite,activation,parse,async(req,res)=>{
  const b=req.body;
  if(!b||Object.keys(b).sort().join(',')!=='challengeId,response'||
     !UUID.test(b.challengeId)||!b.response||Array.isArray(b.response)||
     typeof b.response!=='object'||typeof b.response.id!=='string')
   return res.status(400).json({error:'Invalid registration response.'});
  try{
   const result=await candidate.finishRegistration({
    context:req,challengeId:b.challengeId,response:b.response
   });
   return res.json(result);
  }catch(e){return error(res,e);}
 });
 return router;
}
