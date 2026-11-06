import express from 'express';

// Development only: separate from live security routes. Never mount without
// real Timeclock identity, bot credential and independent manager passkey grant.
export function createStaffEnrollmentInvitationRouter({invitations}={}){
 if(typeof invitations?.issue!=='function'||typeof invitations?.redeem!=='function')
   throw new TypeError('Trusted invitation service required.');
 const router=express.Router();
 router.use((_req,res,next)=>{
   res.set({
     'Cache-Control':'no-store, max-age=0','Pragma':'no-cache',
     'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
     'X-Frame-Options':'DENY'
   });next();
 });
 const safeError=(res,e)=>res.status(e?.status===409?409:e?.status===503?503:403)
   .json({error:e?.status===409?'That invitation has already been used.':
      e?.status===503?'Enrollment service unavailable.':
      'Invitation not authorized or expired.'});
 const snow=/^[0-9]{15,22}$/;
 router.post('/bot/issue',express.json({limit:'2kb',strict:true}),async(req,res)=>{
   const b=req.body;
   if(!b||!['actorDiscordId,guildId,roleIds,targetDiscordId','actorDiscordId,channelId,guildId,roleIds,targetDiscordId'].includes(Object.keys(b).sort().join(','))||
     !snow.test(String(b.actorDiscordId||''))||!snow.test(String(b.targetDiscordId||''))||
     !snow.test(String(b.guildId||''))||
     (b.channelId!==undefined&&!snow.test(String(b.channelId)))||!Array.isArray(b.roleIds))
     return res.status(400).json({error:'Invalid invitation request.'});
   try{
     const invitation=await invitations.issue({
       botCredential:req.get('x-hc-invitation-bot-key'),guild:b.guildId,channelId:b.channelId,
       actorDiscordId:b.actorDiscordId,targetDiscordId:b.targetDiscordId,
       roleIds:b.roleIds,sourceIp:req.ip
     });
     return res.status(201).json(invitation);
   }catch(e){return safeError(res,e);}
 });
 router.post('/redeem',express.json({limit:'2kb',strict:true}),async(req,res)=>{
   if(!req.body||Object.keys(req.body).length!==1||
     typeof req.body.token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(req.body.token))
     return res.status(400).json({error:'Invalid invitation.'});
   try{
     return res.status(201).json(await invitations.redeem({
       context:req,token:req.body.token,sourceIp:req.ip
     }));
   }catch(e){return safeError(res,e);}
 });
 return router;
}
