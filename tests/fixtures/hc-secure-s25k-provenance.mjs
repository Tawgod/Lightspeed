// Offline Security candidate, no runtime authority or durable fence.
import {createHash} from 'node:crypto';
import {createLifetimeCandidate,VERSION} from './hc-secure-s25j-lifetime.mjs';
import {evaluateSyntheticAssurance} from './hc-secure-s25g-lifecycle.mjs';
import {createSyntheticRoleEvaluator} from './hc-secure-s25e-role-policy.mjs';
export {VERSION};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(x)&&x!=='unknown';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const int=Number.isSafeInteger;
const exact=(x,ks)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===ks.length&&ks.every(k=>Object.hasOwn(x,k));
const deny=()=>({allowed:false,reason:'authority-unavailable'});
// Trusted authority adapter supplies the snapshot AND independently read revision.
// Hash is an integrity comparison, not authentication or a signature.
export function createProvenanceCandidate({registry,readEvidence,readEvidenceRevision,readPolicyVersion,clock,decisionMaxMs}){
 const pending=new WeakMap();
 async function issue(input){
  try{
   const q=structuredClone(input),now=clock();
   const evidence=structuredClone(await readEvidence(q));
   if(!exact(evidence,['issuer','tenant','environment','reference','revision','observedAt','expiresAt','policyVersion','snapshotDigest','state'])||
      evidence.issuer!=='synthetic-security-authority'||evidence.tenant!==q.actor.tenant||evidence.environment!==q.actor.environment||
      evidence.reference!==q.evidenceRef||!id(evidence.revision)||!int(now)||!int(evidence.observedAt)||!int(evidence.expiresAt)||
      evidence.observedAt>now||evidence.expiresAt<=now||evidence.observedAt>=evidence.expiresAt||
      evidence.policyVersion!==q.policyVersion||hash(evidence.state)!==evidence.snapshotDigest||
      await readEvidenceRevision(q.actor.tenant,q.evidenceRef)!==evidence.revision)return deny();
   const f=createLifetimeCandidate({registry,readTrustedState:async()=>evidence.state,readPolicyVersion,clock,decisionMaxMs});
   const r=await f.issue(q);
   if(!r.allowed||r.issuedAt!==now||clock()!==now||
      await readEvidenceRevision(q.actor.tenant,q.evidenceRef)!==evidence.revision||
      await readPolicyVersion(q.actor.tenant)!==q.policyVersion||clock()!==now)return deny();
   return {...r,expiresAt:Math.min(r.expiresAt,evidence.expiresAt),authorityRevision:evidence.revision,authorityDigest:hash(evidence)};
  }catch{return deny()}
 }
 return {
  async issue(q){const r=await issue(q);if(r.allowed){Object.freeze(r.actor);Object.freeze(r);pending.set(r,hash(r))}return r},
  async consume(q,r){try{if(!pending.has(r))return false;const binding=pending.get(r);pending.delete(r);
   if(clock()!==r.issuedAt||clock()>=r.expiresAt)return false;
   const fresh=await issue(q);
   return fresh.allowed===true&&hash(fresh)===binding&&await readEvidenceRevision(q.actor.tenant,q.evidenceRef)===r.authorityRevision&&await readPolicyVersion(q.actor.tenant)===r.policyVersion&&clock()===r.issuedAt;
  }catch{return false}}
 };
}
const tuple=['operation','tenant','environment','location','resourceType','resourceId','field'];
const rich=[...tuple,'revision','relationships','quantity','amount','currency','purpose','audience'];
const validEffect=e=>exact(e,rich)&&tuple.every(k=>id(e[k]))&&e.environment==='test'&&id(e.revision)&&id(e.purpose)&&id(e.audience)&&Array.isArray(e.relationships)&&e.relationships.length>0&&e.relationships.every(r=>exact(r,['type','id'])&&id(r.type)&&id(r.id))&&new Set(e.relationships.map(r=>r.type)).size===e.relationships.length&&e.quantity===null&&e.amount===null&&e.currency===null;
const narrow=e=>Object.fromEntries(tuple.map(k=>[k,e[k]]));
// Separate historical inspection profile, employee only; no execution/approval
// replacement/release. Service inspection denied pending Core job contract.
export function createIndependentInspection({operations,readRecord,readAuthority,readPolicyVersion,readEvidenceRevision,clock}){
 const roles=createSyntheticRoleEvaluator(operations);
 return async function inspect(input){
  try{
   const q=structuredClone(input),now=clock();
   if(!exact(q,['version','requestId','actor','tenant','environment','recordId','commandDigest','approvalRef','recordRevision','effect','policyVersion','evidenceRef'])||
      q.version!=='HC-RECONCILE/0.1-candidate'||!id(q.requestId)||!id(q.actor)||!id(q.tenant)||q.environment!=='test'||!id(q.recordId)||!hex(q.commandDigest)||!id(q.approvalRef)||!id(q.recordRevision)||!id(q.policyVersion)||!id(q.evidenceRef)||!int(now)||!validEffect(q.effect)||q.effect.tenant!==q.tenant||!operations.includes(q.effect.operation))return deny();
   const r=structuredClone(await readRecord(q.recordId)),s=structuredClone(await readAuthority(q));
   if(!exact(r,['id','tenant','environment','originalActor','commandDigest','approvalRef','revision','inspectEffect','outcome'])||
      r.id!==q.recordId||r.tenant!==q.tenant||r.environment!==q.environment||!id(r.originalActor)||r.originalActor===q.actor||
      r.commandDigest!==q.commandDigest||r.approvalRef!==q.approvalRef||r.revision!==q.recordRevision||hash(r.inspectEffect)!==hash(q.effect)||
      !['unknown','committed','not-committed'].includes(r.outcome))return deny();
   if(!s||s.issuer!=='synthetic-security-authority'||s.reference!==q.evidenceRef||!id(s.revision)||s.policyVersion!==q.policyVersion||
      !int(s.expiresAt)||s.expiresAt<=now||s.employee?.id!==q.actor||s.employee?.tenant!==q.tenant||s.policy?.version!==q.policyVersion||
      !Array.isArray(s.admittedScopes)||!s.admittedScopes.some(e=>hash(e)===hash(q.effect))||
      !evaluateSyntheticAssurance({actor:s.employee,session:s.session,device:s.device,site:s.site,strongProof:s.strongProof,now,mode:'security-admin',adminMaxMs:s.settings?.version===q.policyVersion?s.settings.adminFreshnessMs:null}).allowed||
      !roles({actor:s.employee,effect:narrow(q.effect),snapshot:s.policy,now}).allowed)return deny();
   if(await readPolicyVersion(q.tenant)!==q.policyVersion||await readEvidenceRevision(q.tenant,q.evidenceRef)!==s.revision||clock()!==now)return deny();
   const current=await readRecord(q.recordId);
   if(hash(current)!==hash(r)||await readEvidenceRevision(q.tenant,q.evidenceRef)!==s.revision||await readPolicyVersion(q.tenant)!==q.policyVersion||clock()!==now)return deny();
   // Minimal projection only; no original actor, approval, payload or authority flags for mutations.
   return {allowed:true,requestId:q.requestId,recordId:r.id,revision:r.revision,outcome:r.outcome,retryAllowed:false,releaseAllowed:false};
  }catch{return deny()}
 };
}
