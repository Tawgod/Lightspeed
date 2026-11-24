// Offline decision-binding fixture ONLY. Never import in server or trust client inputs.
import {createHash} from 'node:crypto';
const stages=new Set(['before-claim','after-claim','after-lock','precommit','projection','reconciliation']);
const ident=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,150}$/.test(v)&&v!=='unknown';
const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const scopeKeys=['tenant','environment','location','resourceType','resourceId','field'];
const effectKeys=['operation',...scopeKeys];
const canonicalEffect=e=>Object.fromEntries(effectKeys.map(k=>[k,e[k]]));
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const actorKeys=['realm','id','tenant'];
const validActor=a=>exact(a,actorKeys)&&['employee','service'].includes(a.realm)&&ident(a.id)&&ident(a.tenant);
const canonicalActor=a=>Object.fromEntries(actorKeys.map(k=>[k,a[k]]));
const canonicalEffects=effects=>effects.map(canonicalEffect).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
export function createSyntheticDecisionContract({registry,readState,clock}={}){
 if(!Array.isArray(registry)||!registry.length||typeof readState!=='function'||typeof clock!=='function')throw new TypeError('Explicit synthetic adapters required');
 // Synthetic allowlist only, not the proposed real registry. No automatic alias resolution.
 const policy=new Map();
 for(const row of registry){
  if(!exact(row,['operation','mode','approvalRequired'])||!ident(row.operation)||!['business','security','read','reconcile'].includes(row.mode)||typeof row.approvalRequired!=='boolean'||policy.has(row.operation))throw new TypeError('Invalid fixture registry');
  policy.set(row.operation,Object.freeze({...row}));
 }
 const deny=reason=>Object.freeze({allowed:false,reason});
 return async function decide(request){
  try{
   if(!exact(request,['actor','sessionId','tenant','environment','effects','commandFingerprint','revision','stage','correlationId','delegationId','approvalId'])||!validActor(request.actor)||request.actor.tenant!==request.tenant||request.environment!=='test'||!stages.has(request.stage)||!ident(request.sessionId)||!ident(request.correlationId)||!ident(request.revision)||!/^[a-f0-9]{64}$/.test(request.commandFingerprint)||request.delegationId!==null||!Array.isArray(request.effects)||!request.effects.length||!(request.approvalId===null||ident(request.approvalId)))return deny('invalid-request');
   if(request.actor.realm!=='employee')return deny('service-contract-pending');
   if(request.effects.some(e=>!exact(e,effectKeys)||!effectKeys.every(k=>ident(e[k]))||e.tenant!==request.tenant||e.environment!==request.environment||!policy.has(e.operation)))return deny('unknown-effect');
   const effects=canonicalEffects(request.effects);
   if(new Set(effects.map(e=>JSON.stringify(e))).size!==effects.length)return deny('duplicate-effect');
   const actor=canonicalActor(request.actor);
   const q=Object.freeze({...request,actor:Object.freeze(actor),effects:Object.freeze(effects.map(Object.freeze))});
   const binding=hash([actor,q.tenant,q.environment,effects,q.commandFingerprint,q.revision,q.stage,q.sessionId,q.correlationId,q.approvalId,q.delegationId]);
   const now=clock();if(!Number.isSafeInteger(now))return deny('clock');
   const state=await readState(q); // Fresh trusted synthetic state per decision.
   if(!state||!ident(state.policyVersion)||state.actorActive!==true||!state.session||state.session.actorId!==actor.id||state.session.tenant!==actor.tenant||state.session.id!==q.sessionId||state.session.active!==true||state.session.revoked!==false||state.session.locked!==false||!Number.isSafeInteger(state.session.expiresAt)||state.session.expiresAt<=now)return deny('session');
   if(state.session.method!=='timeclock-pin'||state.session.siteVerified!==true||state.session.deviceVerified!==true)return deny('assurance-pending');
   if(!Array.isArray(state.grants)||!Array.isArray(state.restrictions))return deny('policy');
   const valid=g=>exact(g,['actorId','effect','expiresAt','revoked'])&&g.actorId===actor.id&&exact(g.effect,effectKeys)&&effectKeys.every(k=>ident(g.effect[k]))&&g.effect.tenant===actor.tenant&&g.effect.environment==='test'&&Number.isSafeInteger(g.expiresAt)&&typeof g.revoked==='boolean';
   if(!state.grants.every(valid)||!state.restrictions.every(valid))return deny('policy');
   const match=(g,e)=>g.revoked===false&&g.expiresAt>now&&effectKeys.every(k=>g.effect[k]===e[k]);
   // Disclosure and reconciliation need separate explicitly scoped read/inspect effects.
   if(q.stage==='projection'&&!effects.some(e=>policy.get(e.operation).mode==='read'))return deny('projection-grant-required');
   if(q.stage==='reconciliation'&&!effects.some(e=>policy.get(e.operation).mode==='reconcile'))return deny('reconciliation-grant-required');
   for(const e of effects){
    const p=policy.get(e.operation);
    if(p.mode==='security')return deny('security-assurance-pending');
    if(state.restrictions.some(g=>match(g,e)))return deny('restriction');
    if(!state.grants.some(g=>match(g,e)))return deny('missing-grant');
    if(p.approvalRequired){
     const a=state.approval;
     const effectDigest=hash(effects);
     if(!a||a.id!==q.approvalId||!ident(a.id)||a.actorId!==actor.id||a.tenant!==actor.tenant||a.commandFingerprint!==q.commandFingerprint||a.revision!==q.revision||a.effectDigest!==effectDigest||!ident(a.reviewerId)||a.reviewerId===actor.id||a.reviewerAuthorized!==true||a.revoked!==false||a.approved!==true||!Number.isSafeInteger(a.expiresAt)||a.expiresAt<=now)return deny('approval');
    }
   }
   return Object.freeze({allowed:true,reason:'synthetic-allow',binding,policyVersion:state.policyVersion,checkedAt:now,stage:q.stage});
  }catch{return deny('indeterminate');}
 };
}
export function syntheticApprovalEffectDigest(effects){return hash(canonicalEffects(effects));}
