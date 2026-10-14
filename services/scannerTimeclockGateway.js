// Assembles the existing matching router, Timeclock PIN identity and signed
// scanner sessions. Still opt-in: server.js does not mount this module.
import express from 'express';
import {createScannerMatchGateway} from '../routes/scannerMatchGateway.js';
import {createScannerSessions} from './scannerSessions.js';
import {createPoCompanionRouter} from '../routes/poCompanion.js';

export function createTimeclockScannerGateway({identity,lookup,sessionSecret,clock=()=>Date.now(),loginLimiter,poReadClient,poPool}={}){
  const router=express.Router();
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  if(!identity?.verifyPin||!identity?.authorize||typeof lookup!=='function'||typeof loginLimiter!=='function'){
    router.use((_req,res)=>res.status(503).json({error:'Scanner authentication is not configured.'}));
    return router;
  }
  const sessions=createScannerSessions({secret:sessionSecret,now:clock});
  router.post('/session',express.json({limit:'1kb'}),async(req,res)=>{
    const pin=req.body?.pin;
    if(typeof pin!=='string'||!/^\d{4}$/.test(pin))return res.status(401).json({error:'Invalid employee credentials.'});
    try{
      const allowed=await loginLimiter({pin,ip:req.ip});
      if(!allowed)return res.status(429).json({error:'Too many sign-in attempts. Try again later.'});
      const employee=await identity.verifyPin(pin);
      if(!employee.canLookup)return res.status(403).json({error:'Scanner access has not been granted to this employee.'});
      return res.json({token:sessions.issue(employee),expiresIn:sessions.ttlSeconds,
        employee:{id:employee.id,name:employee.name,canLookup:employee.canLookup,canApprove:employee.canApprove}});
    }catch(error){return res.status(error.status===403?403:error.status===503?503:401).json({error:'Employee sign-in failed.'});}
  });
  const verifyEmployee=async(req)=>{
    const bearer=String(req.get('authorization')||'');
    if(!bearer.startsWith('Bearer '))throw Object.assign(new Error('Scanner session required.'),{status:401});
    const {employeeId}=sessions.verify(bearer.slice(7));
    const employee=await identity.authorize(employeeId);
    if(!employee.canLookup)throw Object.assign(new Error('Scanner lookup not permitted.'),{status:403});
    return employee;
  };
  if(poReadClient && poPool)router.use(createPoCompanionRouter({verifyEmployee,lightspeed:poReadClient,pool:poPool}));
  router.use(createScannerMatchGateway({verifyEmployee,lookup}));
  return router;
}
