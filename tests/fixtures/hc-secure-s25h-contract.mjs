// HC-AUTHZ/0.1.0 offline fixture. Never mount or accept browser evidence.
import {createHash} from 'node:crypto';
import {createSyntheticRoleEvaluator} from './hc-secure-s25e-role-policy.mjs';
import {evaluateSyntheticAssurance,createSyntheticServiceAuthorization} from './hc-secure-s25g-lifecycle.mjs';
export const VERSION='HC-AUTHZ/0.1.0';
const tuple=['operation','tenant','environment','location','resourceType','resourceId','field'];
const extra=['revision','relationships','quantity','amount','currency','purpose','audience'];
const keys=[...tuple,...extra];
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(x)&&x!=='unknown';
const exact=(x,k)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===k.length&&k.every(y=>Object.hasOwn(x,y));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const canonical=x=>Object.fromEntries(keys.map(k=>[k,k==='relationships'?x[k].map(r=>({type:r.type,id:r.id})).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0):x[k]]));
const sorted=es=>es.map(canonical).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
const narrow=e=>Object.fromEntries(tuple.map(k=>[k,e[k]]));
const dec=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,11})(\.[0-9]{0,5}[1-9])?$/.test(x);
const stages=['admission','claim','lock','precommit','dispatch','replay','readback','projection','inspection'];
const actorKeys=['realm','id','tenant','environment','jobId','jobRevision','delegationId','audience'];
const requestKeys=['version','requestId','correlationId','stage','actor','evidenceRef','executionDigest','executionEffects','accessEffects','approvalId','policyVersion'];
const deny=reason=>({allowed:false,reason});
export function canonicalRequestBinding(q){return hash([q.version,q.requestId,q.correlationId,q.stage,Object.fromEntries(actorKeys.map(k=>[k,q.actor[k]])),q.evidenceRef,q.executionDigest,sorted(q.executionEffects),sorted(q.accessEffects),q.approvalId,q.policyVersion]);}
export function executionScopeDigest(q){return hash([Object.fromEntries(actorKeys.map(k=>[k,q.actor[k]])),q.executionDigest,sorted(q.executionEffects)]);}
export function createOfflineAuthorization({registry,readTrustedState,readPolicyVersion,clock,decisionMaxMs}={}){
 if(!Array.isArray(registry)||!registry.length||![readTrustedState,readPolicyVersion,clock].every(f=>typeof f==='function')||!Number.isSafeInteger(decisionMaxMs)||decisionMaxMs<=0)throw TypeError('explicit fixture adapters required');
 const defs=new Map();
 for(const d of registry){if(!exact(d,['operation','mode','required','approvalRequired','assurance'])||!id(d.operation)||defs.has(d.operation)||!['execute','read','inspect'].includes(d.mode)||!Array.isArray(d.required)||d.required.some(k=>!extra.includes(k))||typeof d.approvalRequired!=='boolean'||!['business','offsite-sensitive','security-admin'].includes(d.assurance))throw TypeError('invalid registry');defs.set(d.operation,structuredClone(d));}
 const roles=createSyntheticRoleEvaluator([...defs.keys()]);
 return async function decide(input){
 try{
 const q=structuredClone(input),now=clock();
 if(!Number.isSafeInteger(now)||!exact(q,requestKeys)||q.version!==VERSION||!id(q.requestId)||!id(q.correlationId)||!stages.includes(q.stage)||!exact(q.actor,actorKeys)||!['employee','service'].includes(q.actor.realm)||!id(q.actor.id)||!id(q.actor.tenant)||q.actor.environment!=='test'||!id(q.evidenceRef)||!id(q.policyVersion)||!/^[a-f0-9]{64}$/.test(q.executionDigest)||!(q.approvalId===null||id(q.approvalId))||!Array.isArray(q.executionEffects)||!q.executionEffects.length||!Array.isArray(q.accessEffects))return deny('request');
 const a=q.actor;
 if(a.realm==='employee'?[a.jobId,a.jobRevision,a.delegationId,a.audience].some(x=>x!==null):!id(a.jobId)||!id(a.jobRevision)||!id(a.audience)||!(a.delegationId===null||id(a.delegationId)))return deny('actor');
 const valid=e=>exact(e,keys)&&tuple.every(k=>id(e[k]))&&e.tenant===a.tenant&&e.environment===a.environment&&defs.has(e.operation)&&['revision','purpose','audience'].every(k=>e[k]===null||id(e[k]))&&Array.isArray(e.relationships)&&e.relationships.every(r=>exact(r,['type','id'])&&id(r.type)&&id(r.id))&&new Set(e.relationships.map(r=>r.type)).size===e.relationships.length&&['quantity','amount'].every(k=>e[k]===null||dec(e[k]))&&(e.amount===null?e.currency===null:typeof e.currency==='string'&&/^[A-Z]{3}$/.test(e.currency))&&defs.get(e.operation).required.every(k=>k==='relationships'?e[k].length>0:e[k]!==null);
 const all=[...q.executionEffects,...q.accessEffects];
 if(!all.every(valid)||new Set(all.map(e=>JSON.stringify(canonical(e)))).size!==all.length)return deny('scope');
 const mode=q.stage==='projection'?'read':q.stage==='inspection'?'inspect':null;
 if(q.executionEffects.some(e=>defs.get(e.operation).mode!=='execute')||(mode?(!q.accessEffects.length||q.accessEffects.some(e=>defs.get(e.operation).mode!==mode)):q.accessEffects.length!==0))return deny('stage');
 if(q.accessEffects.some(e=>!q.executionEffects.some(x=>['tenant','environment','location','resourceType','resourceId','revision'].every(k=>x[k]===e[k])&&JSON.stringify(canonical(x).relationships)===JSON.stringify(canonical(e).relationships))))return deny('related-target');
 const s=structuredClone(await readTrustedState(q));
 if(!s||s.evidenceRef!==q.evidenceRef||s.policyVersion!==q.policyVersion||q.policyVersion!==await readPolicyVersion(a.tenant))return deny('stale-policy');
 // Full typed scope evidence is independently supplied by trusted domain admission;
 // exact match is mandatory in addition to role grants; never infer from tuple.
 if(!Array.isArray(s.admittedScopes)||!s.admittedScopes.every(valid)||!all.every(e=>s.admittedScopes.some(x=>JSON.stringify(canonical(x))===JSON.stringify(canonical(e)))))return deny('scope-admission');
 if(a.realm==='employee'){
 if(s.employee?.id!==a.id||s.employee?.tenant!==a.tenant||s.policy?.version!==q.policyVersion)return deny('identity');
 for(const e of all){
 const mode=defs.get(e.operation).assurance;
 if(mode==='security-admin'&&s.settings?.version!==q.policyVersion)return deny('stale-settings');
 const proof=evaluateSyntheticAssurance({actor:s.employee,session:s.session,device:s.device,site:s.site,strongProof:s.strongProof,now,mode,adminMaxMs:s.settings?.adminFreshnessMs});
 if(!proof.allowed)return deny(proof.reason);
 const r=roles({actor:s.employee,effect:narrow(e),snapshot:s.policy,now});if(!r.allowed)return deny(r.reason);
 }
 }else{
 // Explicit service adapter from prior accepted fixture, no employee-session fallback.
 // Rich scope admission above remains mandatory; prior service rules cover exact tuples.
 if(all.some(e=>defs.get(e.operation).assurance!=='business'))return deny('service-assurance');
 const serviceRequest={actor:{realm:'service',id:a.id,tenant:a.tenant,environment:a.environment},audience:a.audience,jobId:a.jobId,jobRevision:a.jobRevision,delegationId:a.delegationId,stage:({projection:'projection',inspection:'reconciliation',precommit:'precommit',replay:'retry'}[q.stage]||'dispatch'),executionEffects:q.executionEffects.map(narrow),accessEffects:q.accessEffects.map(narrow),fingerprint:executionScopeDigest(q),approvalId:q.approvalId};
 const service=createSyntheticServiceAuthorization({registry:[...defs.values()].map(d=>({operation:d.operation,mode:d.mode,approvalRequired:d.approvalRequired})),readState:async()=>s.serviceState,readPolicyVersion,clock:()=>now});
 const r=await service(serviceRequest);if(!r.allowed||r.policyVersion!==q.policyVersion)return deny('service-denied');
 }
 if(q.executionEffects.some(e=>defs.get(e.operation).approvalRequired)){
 const p=s.approval;
 if(!p||p.id!==q.approvalId||p.scopeDigest!==executionScopeDigest(q)||p.actorId!==a.id||p.tenant!==a.tenant||p.approved!==true||p.revoked!==false||p.reviewerAuthorized!==true||!id(p.reviewerId)||p.reviewerId===a.id||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now)return deny('approval');
 }
 const end=clock();if(!Number.isSafeInteger(now+decisionMaxMs)||end!==now||q.policyVersion!==await readPolicyVersion(a.tenant))return deny('stale-policy');
 return {version:VERSION,requestId:q.requestId,correlationId:q.correlationId,stage:q.stage,decisionBinding:canonicalRequestBinding(q),executionDigest:q.executionDigest,actor:a,policyVersion:q.policyVersion,issuedAt:now,expiresAt:now+decisionMaxMs,allowed:true};
 }catch{return deny('unavailable');}
 };
}
// Consumer fixture validator: trusted in-process callback only, no transport/authentication protocol.
export function validateOfflineAllow(q,r,{now,currentPolicyVersion}={}){
 try{return exact(r,['version','requestId','correlationId','stage','decisionBinding','executionDigest','actor','policyVersion','issuedAt','expiresAt','allowed'])&&r.allowed===true&&r.version===VERSION&&r.requestId===q.requestId&&r.correlationId===q.correlationId&&r.stage===q.stage&&r.executionDigest===q.executionDigest&&r.decisionBinding===canonicalRequestBinding(q)&&exact(r.actor,actorKeys)&&actorKeys.every(k=>r.actor[k]===q.actor[k])&&r.policyVersion===q.policyVersion&&r.policyVersion===currentPolicyVersion&&Number.isSafeInteger(now)&&Number.isSafeInteger(r.issuedAt)&&Number.isSafeInteger(r.expiresAt)&&r.issuedAt<=now&&now<r.expiresAt;}catch{return false;}
}
