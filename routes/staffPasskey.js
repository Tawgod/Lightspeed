import express from 'express';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// DEVELOPMENT ONLY. No routes are mounted in server.js. Strong, independently
// approved passkey enrollment is enforced again by the backend on both calls.
export function createStaffPasskeyRouter({passkeys}={}){
 if(['beginRegistration','finishRegistration','beginAuthentication',
     'finishAuthentication','verify'].some(k=>typeof passkeys?.[k]!=='function'))
   throw new TypeError('Fully verified passkey backend required.');
 const router=express.Router();
 router.use((_req,res,next)=>{res.set({
   'Cache-Control':'no-store, max-age=0',
   'Pragma':'no-cache','X-Frame-Options':'DENY',
   'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'
 });next();});
 const assets={
   '/':{file:'staff-passkey.html',type:'text/html; charset=utf-8'},
   '/client.js':{file:'staff-passkey-client.js',type:'application/javascript; charset=utf-8'},
   '/styles.css':{file:'staff-passkey.css',type:'text/css; charset=utf-8'}
 };
 router.get(['/','/client.js','/styles.css'],async(req,res)=>{
   const asset=assets[req.path];
   if(!asset)return res.sendStatus(404);
   try{
     const bytes=await readFile(path.join(root,asset.file));
     if(req.path==='/')res.set('Content-Security-Policy',
       "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "+
       "base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
     return res.type(asset.type).send(bytes);
   }catch{return res.sendStatus(503);}
 });
 const validId=id=>typeof id==='string'&&
   /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
 const fail=(res,err)=>res.status(err?.status===503?503:403).json({
   error:err?.status===503?'Passkey service is temporarily unavailable.':
     'Passkey verification or authorization required.'
 });
 router.post('/registration/options',express.json({limit:'2kb',strict:true}),async(req,res)=>{
   if(!req.body||Object.keys(req.body).length!==0)
     return res.status(400).json({error:'Invalid registration request.'});
   try{return res.json(await passkeys.beginRegistration({context:req,sourceIp:req.ip}));}
   catch(e){return fail(res,e);}
 });
 router.post('/registration/verify',express.json({limit:'24kb',strict:true}),async(req,res)=>{
   if(!req.body||Object.keys(req.body).length!==2||!validId(req.body.challengeId)||
      !req.body.response||typeof req.body.response!=='object'||Array.isArray(req.body.response))
     return res.status(400).json({error:'Invalid passkey response.'});
   try{return res.json(await passkeys.finishRegistration({
     context:req,challengeId:req.body.challengeId,response:req.body.response
   }));}catch(e){return fail(res,e);}
 });
 router.post('/authentication/options',express.json({limit:'2kb',strict:true}),async(req,res)=>{
   if(!req.body||Object.keys(req.body).length!==0)
     return res.status(400).json({error:'Invalid authentication request.'});
   try{return res.json(await passkeys.beginAuthentication({context:req,sourceIp:req.ip}));}
   catch(e){return fail(res,e);}
 });
 router.post('/authentication/verify',express.json({limit:'16kb',strict:true}),async(req,res)=>{
   if(!req.body||Object.keys(req.body).length!==2||!validId(req.body.challengeId)||
      !req.body.response||typeof req.body.response!=='object'||Array.isArray(req.body.response))
     return res.status(400).json({error:'Invalid passkey response.'});
   try{return res.json(await passkeys.finishAuthentication({
     context:req,challengeId:req.body.challengeId,response:req.body.response
   }));}catch(e){return fail(res,e);}
 });
 router.get('/session',async(req,res)=>{
   try{
     const proof=await passkeys.verify({context:req,token:req.get('x-hc-passkey-proof')});
     return res.json({verified:true,method:'passkey',authenticatedAtMs:proof.authenticatedAtMs});
   }catch(e){return fail(res,e);}
 });
 return router;
}
