// Independent offline candidate; trusted in-process adapters only.
import {createHash} from 'node:crypto';
import {createOfflineAuthorization,VERSION as OLD,validateOfflineAllow} from './hc-secure-s25h-contract.mjs';
import {evaluateSyntheticAssurance} from './hc-secure-s25g-lifecycle.mjs';
import {boundedDecisionExpiry} from './hc-secure-s25i-settings.mjs';
export const VERSION='HC-AUTHZ/0.2.0-candidate';
const integer=Number.isSafeInteger;
const deny=()=>({allowed:false,reason:'authority-unavailable'});
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const same=(a,b)=>['operation','tenant','environment','location','resourceType','resourceId','field'].every(k=>a[k]===b[k]);
// Conservative intersection of all currently applicable grants, and earliest
// future matching rule/assignment transition. No authority derived here.
function policyDeadlines(p,effects,now,out){
 const add=r=>{if(!integer(r.startsAt)||!integer(r.expiresAt))throw Error('lifetime');if(r.revoked!==false)return;if(r.startsAt>now)out.push(r.startsAt);if(r.expiresAt>now)out.push(r.expiresAt)};
 for(const a of p.assignments){
  const role=p.roles.find(r=>r.id===a.roleId);
  const matches=role?.active&&role.rules.filter(r=>effects.some(e=>same(e,r.effect)));
  if(matches?.length){add(a);for(const r of matches)add(r)}
 }
 for(const {rule} of p.individual)if(effects.some(e=>same(e,rule.effect)))add(rule);
}
function deadlines(q,s,registry,now){
 const out=[],effects=[...q.executionEffects,...q.accessEffects];
 const expire=r=>{if(!integer(r?.expiresAt)||r.expiresAt<=now)throw Error('expiry');out.push(r.expiresAt)};
 const defs=effects.map(e=>registry.find(d=>d.operation===e.operation));
 if(q.actor.realm==='employee'){
  expire(s.session);expire(s.device);
  for(const d of defs){
   const proof=evaluateSyntheticAssurance({actor:s.employee,session:s.session,device:s.device,site:s.site,strongProof:s.strongProof,now,mode:d.assurance,adminMaxMs:s.settings?.adminFreshnessMs});
   if(!proof.allowed)throw Error('assurance');
   const onsite=s.site?.active===true&&s.site.revoked===false&&s.site.startsAt<=now&&now<s.site.expiresAt&&s.site.tenant===s.employee.tenant&&s.site.deviceId===s.device.id&&s.site.sessionId===s.session.id&&s.site.verified===true&&s.site.networkClass==='trusted-store';
   // Conservative cap if a site is present and live; evaluator remains authority.
   if(onsite)expire(s.site);
   if(proof.reason==='strong-session'){
    expire(s.strongProof);
    const limit=d.assurance==='security-admin'?s.settings.adminFreshnessMs:d.assurance==='offsite-sensitive'?1800000:null;
    if(limit!==null){const end=s.strongProof.verifiedAt+limit;if(!integer(end)||end<=now)throw Error('freshness');out.push(end)}
   }
  }
  policyDeadlines(s.policy,effects,now,out);
 }else{
  const t=s.serviceState;
  for(const r of [t.service,t.proof,t.job,q.actor.delegationId===null?t.standing:t.delegation])expire(r);
  for(const owner of [t.service,t.job,q.actor.delegationId===null?t.standing:t.delegation]){
   for(const r of owner.rules)if(r.active&&r.revoked===false&&effects.some(e=>same(e,r.effect))){if(r.startsAt>now)out.push(r.startsAt);if(r.expiresAt>now)out.push(r.expiresAt)}
  }
  if(q.actor.delegationId!==null)policyDeadlines(t.delegatorPolicy,effects,now,out);
  if(defs.some(d=>d.approvalRequired))expire(t.approval);
 }
 if(q.executionEffects.some(e=>registry.find(d=>d.operation===e.operation).approvalRequired))expire(s.approval);
 return out;
}
export function createLifetimeCandidate({registry,readTrustedState,readPolicyVersion,clock,decisionMaxMs}){
 registry=structuredClone(registry);
 // Only issued object identity is consumable, once, within this process.
 const pending=new WeakMap();
 async function evaluate(input){
  try{
   const q=structuredClone(input);
   if(q.version!==VERSION)return deny();
   const now=clock(),legacy={...q,version:OLD};
   const s=structuredClone(await readTrustedState(legacy));
   const decide=createOfflineAuthorization({registry,readTrustedState:async()=>s,readPolicyVersion,clock,decisionMaxMs});
   const r=await decide(legacy);
   if(!validateOfflineAllow(legacy,r,{now,currentPolicyVersion:await readPolicyVersion(q.actor.tenant)})||clock()!==now)return deny();
   const expiresAt=boundedDecisionExpiry({now,maxMs:decisionMaxMs,deadlines:deadlines(q,s,registry,now)});
   if(expiresAt===null)return deny();
   return {...r,version:VERSION,expiresAt,evidenceDigest:digest(s),requestDigest:digest(q)};
  }catch{return deny()}
 }
 return {
  async issue(q){
   const r=await evaluate(q);
   if(r.allowed===true){Object.freeze(r.actor);Object.freeze(r);pending.set(r,r.requestDigest)}
   return r;
  },
  async consume(q,r){
   try{
    if(!r||!pending.has(r))return false;
    const binding=pending.get(r);pending.delete(r);
    if(binding!==digest(q)||clock()!==r.issuedAt||clock()>=r.expiresAt)return false;
    const fresh=await evaluate(q);
    return fresh.allowed===true&&digest(fresh)===digest(r)&&await readPolicyVersion(q.actor.tenant)===r.policyVersion&&clock()===r.issuedAt;
   }catch{return false}
  }
 };
}
