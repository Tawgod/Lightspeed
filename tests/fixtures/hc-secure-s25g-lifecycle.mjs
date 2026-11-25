// Offline lifecycle fixture only. Inputs represent trusted synthetic evidence, never browser claims.
// No credentials, network attestation, production grants, or live service transport.
import {createHash} from 'node:crypto';
import {createSyntheticRoleEvaluator} from './hc-secure-s25e-role-policy.mjs';
const keys=['operation','tenant','environment','location','resourceType','resourceId','field'];
const ident=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(v)&&v!=='unknown';
const exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const time=Number.isSafeInteger;
const live=(r,n)=>r&&r.active===true&&r.revoked===false&&time(r.startsAt)&&time(r.expiresAt)&&r.startsAt<=n&&n<r.expiresAt;
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const canon=e=>Object.fromEntries(keys.map(k=>[k,e[k]]));
const same=(a,b)=>keys.every(k=>a[k]===b[k]);
const sorted=es=>es.map(canon).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
const deny=reason=>Object.freeze({allowed:false,reason});
export function evaluateSyntheticAssurance({actor,session,device,site,strongProof,now,mode,adminMaxMs}={}){
 try{
  if(!time(now)||!actor||actor.realm!=='employee'||actor.active!==true||!ident(actor.id)||!ident(actor.tenant)||!ident(session?.id)||!live(session,now)||session.actorId!==actor.id||session.tenant!==actor.tenant||session.locked!==false)return deny('session');
  if(!ident(device?.id)||!live(device,now)||device.tenant!==actor.tenant||session.deviceId!==device.id||!['workstation','personal'].includes(device.kind)||(device.kind==='personal'&&device.actorId!==actor.id)||(device.kind==='workstation'&&device.actorId!==null))return deny('device');
  if(!['business','offsite-sensitive','security-admin'].includes(mode))return deny('mode');
  const onsite=!!(site&&live(site,now)&&site.tenant===actor.tenant&&ident(site.id)&&site.deviceId===device.id&&site.sessionId===session.id&&site.verified===true&&site.networkClass==='trusted-store');
  const remote=session.method==='strong'&&session.offsiteAllowed===true;
  if(!onsite&&!remote)return deny('site-or-offsite');
  if(onsite&&!['timeclock-pin','strong'].includes(session.method))return deny('method');
  if(mode==='business'&&onsite)return {allowed:true,reason:'onsite-session'};
  // Remote login proof is individually bound and live. For sensitive remote actions,
  // owner-approved 30 minute freshness is non-sliding; other remote assurance remains provisional.
  const limit=mode==='security-admin'?adminMaxMs:mode==='offsite-sensitive'?1800000:null;
  if(mode==='security-admin'&&(!time(limit)||limit<=0))return deny('admin-policy-pending');
  if(!strongProof||!live(strongProof,now)||strongProof.actorId!==actor.id||strongProof.tenant!==actor.tenant||strongProof.sessionId!==session.id||strongProof.deviceId!==device.id||!time(strongProof.verifiedAt)||strongProof.verifiedAt>now||strongProof.verifiedAt<strongProof.startsAt||strongProof.verifiedAt<session.startsAt||(limit!==null&&now-strongProof.verifiedAt>=limit))return deny('strong-proof');
  return {allowed:true,reason:'strong-session'};
 }catch{return deny('indeterminate');}
}
export function createSyntheticServiceAuthorization({registry,readState,readPolicyVersion,clock}={}){
 if(!Array.isArray(registry)||!registry.length||registry.some(x=>!exact(x,['operation','mode','approvalRequired'])||!ident(x.operation)||!['execute','read','inspect'].includes(x.mode)||typeof x.approvalRequired!=='boolean')||new Set(registry.map(x=>x.operation)).size!==registry.length||![readState,readPolicyVersion,clock].every(x=>typeof x==='function'))throw TypeError('Explicit fixture adapters required');
 const defs=new Map(registry.map(x=>[x.operation,Object.freeze({...x})]));
 const roles=createSyntheticRoleEvaluator([...defs.keys()]);
 return async function decide(input){
  try{
   const q=structuredClone(input),now=clock();
   if(!time(now)||!exact(q,['actor','audience','jobId','jobRevision','delegationId','stage','executionEffects','accessEffects','fingerprint','approvalId'])||!exact(q.actor,['realm','id','tenant','environment'])||q.actor.realm!=='service'||!ident(q.actor.id)||!ident(q.actor.tenant)||q.actor.environment!=='test'||!ident(q.audience)||!ident(q.jobId)||!ident(q.jobRevision)||!(q.delegationId===null||ident(q.delegationId))||!['dispatch','retry','precommit','projection','reconciliation'].includes(q.stage)||!Array.isArray(q.executionEffects)||!q.executionEffects.length||!Array.isArray(q.accessEffects)||!/^[a-f0-9]{64}$/.test(q.fingerprint)||!(q.approvalId===null||ident(q.approvalId)))return deny('request');
   const valid=e=>exact(e,keys)&&keys.every(k=>ident(e[k]))&&e.tenant===q.actor.tenant&&e.environment==='test'&&defs.has(e.operation);
   const all=[...q.executionEffects,...q.accessEffects];
   if(!all.every(valid)||new Set(all.map(e=>JSON.stringify(canon(e)))).size!==all.length)return deny('effect');
   const mode=q.stage==='projection'?'read':q.stage==='reconciliation'?'inspect':null;
   if(q.executionEffects.some(e=>defs.get(e.operation).mode!=='execute')||(mode?(!q.accessEffects.length||q.accessEffects.some(e=>defs.get(e.operation).mode!==mode)):q.accessEffects.length>0))return deny('stage');
   if(q.accessEffects.some(e=>!q.executionEffects.some(x=>keys.filter(k=>k!=='operation'&&k!=='field').every(k=>x[k]===e[k]))))return deny('access-target');
   const binding=digest([q.actor.realm,q.actor.id,q.actor.tenant,q.actor.environment,q.audience,q.jobId,q.jobRevision,q.delegationId,q.fingerprint,sorted(q.executionEffects)]);
   const s=structuredClone(await readState(q));
   if(!s||!ident(s.version)||s.version!==await readPolicyVersion(q.actor.tenant))return deny('stale-policy');
   const service=s.service,job=s.job,proof=s.proof;
   if(!live(service,now)||service.id!==q.actor.id||service.tenant!==q.actor.tenant||service.environment!=='test'||!live(proof,now)||proof.serviceId!==service.id||proof.tenant!==service.tenant||proof.environment!=='test'||proof.audience!==q.audience||proof.kind!=='service-proof'||proof.credentialRevision!==service.credentialRevision||!ident(service.credentialRevision))return deny('service');
   if(!live(job,now)||job.id!==q.jobId||job.revision!==q.jobRevision||job.serviceId!==service.id||job.tenant!==service.tenant||job.environment!=='test'||job.audience!==q.audience||job.executionBinding!==binding||!ident(job.ownerId))return deny('job');
   const checkRules=rules=>Array.isArray(rules)&&rules.every(r=>exact(r,['effect','kind','active','revoked','startsAt','expiresAt'])&&valid(r.effect)&&['grant','restrict'].includes(r.kind)&&typeof r.active==='boolean'&&typeof r.revoked==='boolean'&&time(r.startsAt)&&time(r.expiresAt)&&r.startsAt<r.expiresAt);
   const allowed=(rules,e)=>rules.some(r=>live(r,now)&&r.kind==='grant'&&same(r.effect,e))&&!rules.some(r=>live(r,now)&&r.kind==='restrict'&&same(r.effect,e));
   if(!checkRules(service.rules)||!checkRules(job.rules))return deny('policy');
   if(!all.every(e=>allowed(service.rules,e)&&allowed(job.rules,e)))return deny('scope');
   if(q.delegationId!==null){
    const d=s.delegation,a=s.delegator;
    if(job.kind!=='delegated'||!live(d,now)||d.id!==q.delegationId||d.serviceId!==service.id||d.jobId!==job.id||d.jobRevision!==job.revision||d.audience!==q.audience||d.tenant!==service.tenant||d.environment!=='test'||d.executionBinding!==binding||!a||a.realm!=='employee'||a.active!==true||a.id!==d.employeeId||a.id!==job.ownerId||a.tenant!==service.tenant||s.delegatorPolicy?.version!==s.version||!checkRules(d.rules))return deny('delegation');
    if(!all.every(e=>allowed(d.rules,e)&&roles({actor:a,effect:e,snapshot:s.delegatorPolicy,now}).allowed))return deny('delegated-scope');
   }else{
    const standing=s.standing;
    if(job.kind!=='standing'||s.delegation!==null||!live(standing,now)||standing.serviceId!==service.id||standing.jobId!==job.id||standing.jobRevision!==job.revision||standing.ownerId!==job.ownerId||standing.tenant!==service.tenant||standing.environment!=='test'||standing.audience!==q.audience||standing.executionBinding!==binding||standing.approved!==true||!checkRules(standing.rules)||!all.every(e=>allowed(standing.rules,e)))return deny('standing');
   }
   if(q.executionEffects.some(e=>defs.get(e.operation).approvalRequired)){
    const a=s.approval;
    if(!live(a,now)||!ident(a.id)||a.id!==q.approvalId||a.executionBinding!==binding||a.tenant!==service.tenant||a.environment!=='test'||a.approved!==true||a.reviewerAuthorized!==true||!ident(a.reviewerId)||a.reviewerId===job.ownerId)return deny('approval');
   }
   if(clock()!==now||s.version!==await readPolicyVersion(q.actor.tenant))return deny('stale-policy');
   return Object.freeze({allowed:true,reason:'synthetic-service-allow',policyVersion:s.version,executionBinding:binding,decisionBinding:digest([binding,q.stage,sorted(q.accessEffects),s.version])});
  }catch{return deny('indeterminate');}
 };
}
// Used by fixture authors to precompute trusted immutable job and approval evidence.
export function syntheticServiceExecutionBinding(q){return digest([q.actor.realm,q.actor.id,q.actor.tenant,q.actor.environment,q.audience,q.jobId,q.jobRevision,q.delegationId,q.fingerprint,sorted(q.executionEffects)]);}
