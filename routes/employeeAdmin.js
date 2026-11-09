import express from 'express';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {listAdminSettingDescriptors,findAdminSettingDescriptor} from '../services/security/adminSettingsRegistry.js';
import {visibleAdminSections} from '../services/security/adminPermissionCatalog.js';

// Candidate only. Never mount without trusted Timeclock identity, real enrolled
// passkey/TOTP verification and a reviewed backend admin permission checker.
// No employee records or configuration writes exist in this router.
export function createEmployeeAdminRouter({adminAccess,delegations=null,resolveCapabilities=null,employeeDirectory=null,onboardingQueue=null}={}){
 if(onboardingQueue!==null && (typeof onboardingQueue?.request!=='function'||typeof onboardingQueue?.ownRequests!=='function'))
  throw new TypeError('Verified onboarding workflow is required.');
 if(employeeDirectory!==null && typeof employeeDirectory?.list!=='function')
   throw new TypeError('Verified Timeclock directory adapter required.');
 if(resolveCapabilities!==null && typeof resolveCapabilities!=='function')
   throw new TypeError('Read-only administrator capability resolver must be a function.');
 if(delegations!==null && ['capabilitiesForVerifiedEmployee','listGrants','changeAdminGrant','changeGrantScope','changeSettingScope','changeEmployeeToolGrant','listEmployeeToolGrants'].some(x=>typeof delegations?.[x]!=='function'))
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
     const caps=delegations?await delegations.capabilitiesForVerifiedEmployee(authorized.employeeId):
       resolveCapabilities?await resolveCapabilities(authorized.employeeId):null;
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
       configurationWritesEnabled:false,
       delegatedGrantManagementEnabled:Boolean(delegations)
     });
   }catch(e){error(res,e);}
 });
 router.get('/api/settings',async(req,res)=>{
   try{
     const actor=await adminAccess.authorize({context:req,operation:'tools.settings.read'});
     const caps=delegations?await delegations.capabilitiesForVerifiedEmployee(actor.employeeId):
       resolveCapabilities?await resolveCapabilities(actor.employeeId):null;
     // Avoid exposing employee/security/Timeclock admin metadata to
     // managers who can change only non-sensitive tool configurations.
     const items=caps?.role==='owner'
       ?listAdminSettingDescriptors()
       :listAdminSettingDescriptors({section:'Tool Settings'});
     return res.json({items,readOnly:true});
   }catch(e){return error(res,e);}
 });
 router.get('/api/settings/:id',async(req,res)=>{
   try{
     const actor=await adminAccess.authorize({context:req,operation:'tools.settings.read'});
     const caps=delegations?await delegations.capabilitiesForVerifiedEmployee(actor.employeeId):null;
     const entry=findAdminSettingDescriptor(req.params.id);
     if(entry && caps?.role!=='owner' && entry.section!=='Tool Settings')return res.sendStatus(404);
     if(!entry)return res.sendStatus(404);
     return res.json({item:{...entry},readOnly:true});
   }catch(e){return error(res,e);}
 });
 // Employee records are an explicitly optional Timeclock-only integration.
 // Merely having employees.onboard is NOT an employee-list permission.
 // Real employee data is never mounted in synthetic staging.
 if(employeeDirectory){
  router.get('/api/employees',async(req,res)=>{
   const scope=req.query.scope===undefined?'directory':req.query.scope;
   if(!['directory','private'].includes(scope)||
      Object.keys(req.query).some(key=>key!=='scope'))
    return res.status(400).json({error:'Invalid employee directory scope.'});
   try{
    await adminAccess.authorize({context:req,operation:
      scope==='private'?'employees.private.read':'employees.directory.read'});
    return res.json(await employeeDirectory.list({includePrivate:scope==='private'}));
   }catch(e){return error(res,e);}
  });
 }
 // Restricted onboarding request intake. No employee directory read is needed.
 // Requests do not create staff/PINs or sync Lightspeed; only a later approved
 // Timeclock integration can execute a reviewed enrollment.
 if(onboardingQueue){
  router.get('/api/onboarding/requests',async(req,res)=>{
   try{return res.json(await onboardingQueue.ownRequests({context:req}));}
   catch(e){return error(res,e);}
  });
  router.post('/api/onboarding/requests',express.json({limit:'2kb',strict:true}),async(req,res)=>{
   const body=req.body;
   if(!body||Object.keys(body).sort().join(',')!=='name,reason,requestKey,requestedRole')
    return res.status(400).json({error:'Invalid onboarding intake.'});
   try{
    const created=await onboardingQueue.request({context:req,...body});
    return res.status(created.replayed?200:202).json(created);
   }catch(e){
    if(e?.status===400)return res.status(400).json({error:'Invalid onboarding intake.'});
    return error(res,e);
   }
  });
 }
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
  router.post('/api/setting-scopes',express.json({limit:'2kb',strict:true}),async(req,res)=>{
   const body=req.body;
   if(!body||Object.keys(body).sort().join(',')!=='enabled,reason,settingId,targetEmployeeId')
    return res.status(400).json({error:'Invalid settings scope request.'});
   try{return res.json(await delegations.changeSettingScope({context:req,...body}));}
   catch(e){return error(res,e);}
  });
  router.get('/api/employee-tool-grants/:employeeId',async(req,res)=>{
   try{return res.json(await delegations.listEmployeeToolGrants({
     context:req,targetEmployeeId:req.params.employeeId
   }));}
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
