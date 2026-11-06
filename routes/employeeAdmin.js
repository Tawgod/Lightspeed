import express from 'express';
import {listAdminSettingDescriptors,findAdminSettingDescriptor} from '../services/security/adminSettingsRegistry.js';

// Candidate only. Never mount without trusted Timeclock identity, real enrolled
// passkey/TOTP verification and a reviewed backend admin permission checker.
// No employee records or configuration writes exist in this router.
export function createEmployeeAdminRouter({adminAccess}={}){
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
 const error=(res,e)=>res.status(e?.status===503?503:403).json({
   error:e?.status===503?'Administrator authorization temporarily unavailable.':
     'Independent administrator verification required.'
 });
 router.get('/api/overview',async(req,res)=>{
   try{
     const authorized=await adminAccess.authorize({context:req,operation:'admin.read'});
     res.json({
       employeeId:authorized.employeeId,
       authMethod:authorized.method,
       panels:['Employees','Security','Verified Computers','Timeclock','Tool Permissions','Tool Settings','Audit'],
       status:'development',
       settingCount:listAdminSettingDescriptors().length,
       connectedEmployeeData:false,
       configurationWritesEnabled:false
     });
   }catch(e){error(res,e);}
 });
 router.get('/api/settings',async(req,res)=>{
   try{
     await adminAccess.authorize({context:req,operation:'tools.settings.read'});
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
 // Do not add a generic PATCH /settings/{id} endpoint: every setting must be
 // implemented by its owning service with schema, exact grant and audit.
 return router;
}
