import express from 'express';

// DEVELOPMENT ONLY: never mount until independent manager provisioning,
// trusted proxy IP configuration, employee acceptance and release approval.
// There is deliberately NO workstation self-registration or reset endpoint.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error=(res,e)=>res.status(e?.status===503?503:e?.status===429?429:403).json({
 error:e?.status===503?'Station verification temporarily unavailable.':
   'Approved workstation verification required.'
});
export function createStaffStationProofRouter({workstations}={}){
 if(['beginChallenge','completeChallenge','verify'].some(name=>typeof workstations?.[name]!=='function')){
   throw new TypeError('An independently provisioned and durable workstation verifier is required.');
 }
 const router=express.Router();
 router.use((_req,res,next)=>{
   res.set({
     'Cache-Control':'no-store, max-age=0',
     'Referrer-Policy':'no-referrer',
     'X-Content-Type-Options':'nosniff',
     'X-Frame-Options':'DENY'
   });next();
 });
 router.post('/challenge',express.json({limit:'1kb',strict:true}),async(req,res)=>{
   if(!req.body||Object.keys(req.body).length!==1||
      typeof req.body.deviceId!=='string'||!UUID.test(req.body.deviceId))
     return res.status(400).json({error:'Invalid station request.'});
   try{
     return res.json(await workstations.beginChallenge({
       context:req,deviceId:req.body.deviceId,sourceIp:req.ip
     }));
   }catch(e){return error(res,e);}
 });
 router.post('/verify',express.json({limit:'1kb',strict:true}),async(req,res)=>{
   if(!req.body||Object.keys(req.body).length!==2||
      typeof req.body.challengeId!=='string'||!UUID.test(req.body.challengeId)||
      typeof req.body.signature!=='string'||!(/^[A-Za-z0-9_-]{80,120}$/).test(req.body.signature))
     return res.status(400).json({error:'Invalid station proof.'});
   try{
     return res.json(await workstations.completeChallenge({
       context:req,challengeId:req.body.challengeId,signature:req.body.signature
     }));
   }catch(e){return error(res,e);}
 });
 router.get('/session',async(req,res)=>{
   try{
     const token=req.get('x-hc-station-proof');
     const verified=await workstations.verify({context:req,token});
     return res.json({verified:true,deviceId:verified.deviceId,expiresAtMs:verified.expiresAtMs});
   }catch(e){return error(res,e);}
 });
 return router;
}
