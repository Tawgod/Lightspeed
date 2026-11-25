// Isolated consumer. Security owns all decision and binding semantics.
import {randomUUID} from 'node:crypto';
import {fingerprintLightspeedPayload as hash} from './idempotency.js';
import {createLocalTransactionM8Internal} from './localTransactionM8Internal.js';
import {createRemoteMutationM8Internal} from './remoteMutationM8Internal.js';
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const copy=v=>freeze(structuredClone(v));
const fail=()=>Object.assign(Error('M8 fixture operation cannot proceed safely.'),{code:'CORE_FORBIDDEN',outcome:'undisclosed'});
const stages={beforeClaim:'admission',afterClaim:'claim',afterLocks:'lock',beforeCommit:'precommit',beforeReconcile:'readback',beforeDisclosure:'replay',afterProjection:'replay',beforeReserve:'admission',afterReserve:'claim',beforeDispatch:'dispatch',dispatch:'dispatch',afterReadback:'readback',beforeLookup:'replay',replay:'replay'};
const bounded=async(fn,ms)=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail()),ms);})]);}finally{clearTimeout(timer);}};
export function createAuthorizationM8({security,decide,readPolicyVersion,clock,deriveScope,timeoutMs=1000}={}){
 if(security?.VERSION!=='HC-AUTHZ/0.1.0'||![security.executionScopeDigest,security.validateOfflineAllow,decide,readPolicyVersion,clock,deriveScope].every(f=>typeof f==='function')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw TypeError('Explicit offline Security adapters required');
 // deriveScope is a trusted domain adapter, never request input. It maps exact M7
 // operation/target/location/field tuples to independently admitted rich facts.
 function narrow(command,e){
  if(command.version==='core.execution.v7')return e.fields.map(field=>[e.operation,e.target.type,e.target.id,e.location,field]);
  return [[e.operation,'product',e.target.productId,e.location,e.field,e.target.variantId,e.supplierId]];
 }
 function cover(command,original,rich){
  if(!Array.isArray(original)||!Array.isArray(rich))throw fail();
  const expected=original.flatMap(e=>narrow(command,e)).map(x=>JSON.stringify(x)).sort();
  const actual=rich.map(e=>{
   const tuple=[e.operation,e.resourceType,e.resourceId,e.location,e.field];
   if(command.version==='core.remote.v7')tuple.push(e.relationships.find(r=>r.type==='variant')?.id??null,e.relationships.find(r=>r.type==='supplier')?.id??null);
   if(e.tenant!==command.tenant||e.environment!=='test')throw fail();
   return JSON.stringify(tuple);
  }).sort();
  if(hash(expected)!==hash(actual))throw fail();
 }
 async function bindScope({command,digest,approval,reads,inspects}){
  try{
   if(command.actor.realm!=='employee')throw fail();
   const actor={realm:'employee',id:command.actor.id,tenant:command.tenant,environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null};
   const facts=copy(await bounded(()=>deriveScope({command,digest,reads:copy(reads),inspects:copy(inspects)}),timeoutMs));
   cover(command,command.effects,facts.executionEffects);cover(command,reads,facts.readEffects);cover(command,inspects,facts.inspectEffects);
   const base=copy({version:security.VERSION,actor,evidenceRef:facts.evidenceRef,executionDigest:digest,executionEffects:facts.executionEffects,approvalId:approval.reference});
   const scopeDigest=security.executionScopeDigest(base);
   // Preserve M7 key namespace. Distinct persistence fingerprint binds rich scope
   // and original approval; legacy M7 row conflicts rather than reruns.
   return copy({base,scopeDigest,persistenceDigest:hash(['core.authz.m8',digest,scopeDigest,approval.reference]),readEffects:facts.readEffects,inspectEffects:facts.inspectEffects});
  }catch{throw fail();}
 }
 async function authorizeStage({bound,stage,kind,effects,command,correlationId}){
  try{
   const accessEffects=kind==='read'?bound.readEffects:kind==='inspect'?bound.inspectEffects:[];
   if(kind!=='execute')cover(command,effects,accessEffects);
   const mapped=kind==='read'?'projection':kind==='inspect'?'inspection':stages[stage];
   if(!mapped)return false;
   const policyVersion=await bounded(()=>readPolicyVersion(command.tenant),timeoutMs);
   const q=copy({...bound.base,requestId:randomUUID(),correlationId,stage:mapped,accessEffects,policyVersion});
   if(security.executionScopeDigest(q)!==bound.scopeDigest)return false;
   const response=copy(await bounded(()=>decide(q),timeoutMs));
   const currentPolicyVersion=await bounded(()=>readPolicyVersion(command.tenant),timeoutMs),now=clock();
   return response?.issuedAt===now&&security.validateOfflineAllow(q,response,{now,currentPolicyVersion})===true;
  }catch{return false;}
 }
 return Object.freeze({bindScope,authorizeStage});
}
export function createLocalTransactionM8({authorization,...options}){
 return createLocalTransactionM8Internal({...options,bindScope:authorization.bindScope,authorizeStage:authorization.authorizeStage});
}
export function createRemoteMutationM8({authorization,...options}){
 return createRemoteMutationM8Internal({...options,bindScope:authorization.bindScope,authorizeStage:authorization.authorizeStage});
}
