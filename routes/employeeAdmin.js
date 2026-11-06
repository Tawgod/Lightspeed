import express from 'express';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {listAdminSettingDescriptors,findAdminSettingDescriptor} from '../services/security/adminSettingsRegistry.js';
import {visibleAdminSections} from '../services/security/adminPermissionCatalog.js';

// Candidate only. Never mount without trusted Timeclock identity, real enrolled
// passkey/TOTP verification and a reviewed backend admin permission checker.
// No employee records or configuration writes exist in this router.
export function createEmployeeAdminRouter({adminAccess,delegations=null}={}){
 if(delegations!==null && ['capabilitiesForVerifiedEmployee','listGrants','changeAdminGrant','changeGrantScope','changeEmployeeToolGrant'].some(x=>typeof delegations?.[x]!=='function'))
   throw new TypeError('Trusted server-side delegated permissions adapter required.');
 if(typeof adminAccess?.authorize!=='function')
   throw new TypeError('Strong administrator authorization required.');
 const router=express.Router();
 router.use((_req,res,next)=>{
   res.set({
     'Cache-Control':'no-store, max-age=0',
     'Referrer-Policy':'no-referrer',
     'X-Content-Type-Options':'nosniff',
     'X-Frame-Options':'DENY'
   });
   next();
 });
 // Static shell reveals no staff data, secrets or mutable configuration;
 // all API data independently requires an enrolled factor and admin grant.
 const assets=Object.freeze({
  '/':{name:'employee-admin.html',type:'text/html; charset=utf-8'},
  '/client.js':{name:'employee-admin-client.js',type:'application/javascript'},
  '/styles.css':{name:'employee-admin.css',type:'text/css'}
 });
 router.get(['/', '/client.js', '/styles.css'],async(req,res)=>{
  const asset=assets[req.path];
  if(!asset)return res.sendStatus(404);
  if(req.path==='/')res.set('Content-Security-Policy',
   "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  try{
   const bytes=await readFile(fileURLToPath(new URL('../admin/'+asset.name,import.meta.url)));
   return res.type(asset.type).send(bytes);
  }catch{return res.sendStatus(503);}
 });
 const error=(res,e)=>res.status(e?.status===503?503:403).json({
   error:e?.status===503?'Administrator authorization temporarily unavailable.':
     'Independent administrator verification required.'
 });
 router.get('/api/overview',async(req,res)=>{
   try{
     const authorized=await adminAccess.authorize({context:req,operation:'admin.read'});
     const caps=delegations?await delegations.capabilitiesForVerifiedEmployee(authorized.employeeId):null;
     const sections=caps?visibleAdminSections(caps.operations,caps.role):{};
     res.json({
       employeeId:authorized.employeeId,
       authMethod:authorized.method,
       role:caps?.role||'unconfigured',
       grantedOperations:caps?.operations||[],
       sectionAccess:sections,
       panels:caps?Object.entries(sections).filter(([,yes])=>yes).map(([label])=>label):[],
       status:'development',
       settingCount:0,
       connectedEmployeeData:false,
       configurationWritesEnabled:false
     });
   }catch(e){error(res,e);}
 });
 router.get('/api/settings',async(req,res)=>{
   try{
     const actor=await adminAccess.authorize({context:req,operation:'tools.settings.read'});
     if(delegations) await delegations.capabilitiesForVerifiedEmployee(actor.employeeId);
     return res.json({items:listAdminSettingDescriptors(),readOnly:true});
   }catch(e){return error(res,e);}
 });
 router.get('/api/settings/:id',async(req,res)=>{
   try{
     await adminAccess.authorize({context:req,operation:'tools.settings.read'});
     const entry=findAdminSettingDescriptor(req.params.id);
     if(!entry)return res.sendStatus(404);
     return res.json({item:{...entry},readOnly:true});
   }catch(e){return error(res,e);}
 });
 // Strongly verified owner-facing delegated admin management.
 // Only configured adapters can expose these paths; no production mount exists.
 if(delegations){
  router.get('/api/admin-grants/:employeeId',async(req,res)=>{
   try{return res.json(await delegations.listGrants({context:req,targetEmployeeId:req.params.employeeId}));}
   catch(e){return error(res,e);}
  });
  router.post('/api/admin-grants',express.json({limit:'2kb',strict:true}),async(req,res)=>{
   const body=req.body;
   if(!body||Object.keys(body).sort().join(',')!=='enabled,operation,reason,targetEmployeeId')
    return res.status(400).json({error:'Invalid admin grant request.'});
   try{return res.json(await delegations.changeAdminGrant({context:req,...body}));}
   catch(e){return error(res,e);}
  });
  router.post('/api/grant-scopes',express.json({limit:'2kb',strict:true}),async(req,res)=>{
   const body=req.body;
   if(!body||Object.keys(body).sort().join(',')!=='enabled,reason,targetEmployeeId,toolOperation')
    return res.status(400).json({error:'Invalid scope request.'});
   try{return res.json(await delegations.changeGrantScope({context:req,...body}));}
   catch(e){return error(res,e);}
  });
  router.post('/api/employee-tool-grants',express.json({limit:'2kb',strict:true}),async(req,res)=>{
   const body=req.body;
   if(!body||Object.keys(body).sort().join(',')!=='enabled,reason,targetEmployeeId,toolOperation')
    return res.status(400).json({error:'Invalid tool permission request.'});
   try{return res.json(await delegations.changeEmployeeToolGrant({context:req,...body}));}
   catch(e){return error(res,e);}
  });
 }
 // Do not add a generic PATCH /settings/{id} endpoint: every setting must be
 // implemented by its owning service with schema, exact grant and audit.
 return router;
}
