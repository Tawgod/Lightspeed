import {prepareRemoteExecutionM7,normalizeRemoteEffectsM7,validatedRemoteReceiptM7} from './remoteMutationM7.js';
import {randomUUID} from 'node:crypto';
import {fingerprintLightspeedPayload as hash} from './idempotency.js';
const copy=v=>{hash(v);return JSON.parse(JSON.stringify(v));};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const literal=v=>typeof v==='string'&&v.length>0&&v.length<=512&&v.trim()===v&&!/[\x00-\x1f]/.test(v);
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const denied=()=>({state:'denied',retryAllowed:false});
const unknown=()=>({state:'unknown',retryAllowed:false});
const conflict=()=>({state:'conflict',retryAllowed:false});
// All callbacks trusted synthetic fixtures. Store operations are short local transactions;
// dispatch and observation always occur after store calls return.
export function createRemoteMutationM8Internal({tenant,store,authorizeStage,bindScope,deriveFresh,dispatch,observe}={}){
 if(!literal(tenant)||![authorizeStage,bindScope,deriveFresh,dispatch,observe].every(f=>typeof f==='function')||!['reserve','beginDispatch','lookup','mark','appendAudit'].every(k=>typeof store?.[k]==='function'))throw TypeError('Explicit synthetic adapters required');
 const allow=async(fn,arg)=>{try{return await fn(arg)===true;}catch{return false;}};
 async function bind(execution,approval,readEffects,inspectEffects){
  const {environment,version,...raw}=copy(execution);
  const command=prepareRemoteExecutionM7(raw),digest=hash(command),proof=freeze(copy(approval));
  if(command.tenant!==tenant||hash(execution)!==digest||!exact(proof,['reference','executionDigest','reviewerId','expiresAt'])||proof.executionDigest!==digest||!literal(proof.reference)||!literal(proof.reviewerId)||!Number.isSafeInteger(proof.expiresAt))throw TypeError('Invalid binding');
  const bound=await bindScope({command,digest,approval:proof,reads:readEffects,inspects:inspectEffects});
  return {command,digest,proof,bound,correlationId:randomUUID(),meta:{tenant,key:command.key,digest:bound.persistenceDigest,approvalDigest:hash(proof)}};
 }
 const check=async(b,stage)=>{
  return allow(authorizeStage,{...b,stage,kind:'execute',effects:[]});
 };
 const access=async(b,stage,kind,requested)=>{
  let list;try{list=normalizeRemoteEffectsM7(copy(requested),b.command.target);}catch{return false;}
  return allow(authorizeStage,{...b,stage,kind,effects:list});
 };
 const fresh=async b=>{try{return hash(await deriveFresh(b.command))===b.digest;}catch{return false;}};
 const matches=(row,b)=>row?.digest===b.meta.digest&&row.approvalDigest===b.meta.approvalDigest;
 async function project(b,row,readEffects){
  if(!await check(b,'beforeDisclosure')||!await access(b,'readProjection','read',readEffects))return denied();
  if(!matches(row,b)||row.state!=='verified')return unknown();
  const receipt=row.receipt;
  if(!exact(receipt,['eventId','revision'])||!literal(receipt.eventId)||!literal(receipt.revision))return unknown();
  const result={};for(const field of ['eventId','revision'])if(readEffects.some(e=>e.field===field))result[field]=receipt[field];
  if(!Object.keys(result).length)return denied();
  if(!await check(b,'afterProjection')||!await access(b,'afterProjection','read',readEffects))return denied();
  return {state:'verified',retryAllowed:false,result};
 }
 async function reconcileBound(b,row,inspectEffects,readEffects){
  if(!await check(b,'beforeReconcile')||!await access(b,'inspection','inspect',inspectEffects))return denied();
  if(!matches(row,b)||!['dispatching','unknown','verified'].includes(row.state))return unknown();
  if(row.state==='verified')return project(b,row,readEffects);
  let evidence;try{evidence=await observe({command:b.command,digest:b.digest,eventId:row.eventId});}catch{return unknown();}
  const receipt=validatedRemoteReceiptM7(b.command,b.digest,row.eventId,evidence);
  if(!receipt)return unknown();
  if(!await check(b,'afterReadback')||!await access(b,'afterReadback','inspect',inspectEffects))return denied();
  try{await store.mark({...b.meta,state:'verified',receipt});}catch{return unknown();}
  return project(b,{...row,state:'verified',receipt},readEffects);
 }
 return Object.freeze({
  async run({execution,approval,readEffects,inspectEffects}){
   let b;try{readEffects=freeze(copy(readEffects));inspectEffects=freeze(copy(inspectEffects));b=await bind(execution,approval,readEffects,inspectEffects);}catch{return denied();}
   if(!await check(b,'beforeReserve'))return denied();
   let claim;try{claim=await store.reserve({...b.meta,keys:b.command.reservationKeys});}catch{return unknown();}
   if(claim.state==='conflict')return conflict();
   if(claim.state!=='claimed'){
    if(!matches(claim,b))return denied();
    if(!await check(b,'replay'))return denied();
    if(claim.state!=='verified')return unknown();
    return project(b,claim,readEffects);
   }
   try{
    if(!await check(b,'afterReserve')||!await fresh(b)||!await check(b,'beforeDispatch')||!await fresh(b)){
     await store.mark({...b.meta,state:'blocked'});return denied();
    }
    const eventId=randomUUID();
    // Atomic dispatch marker and requested audit must commit before callback.
    await store.beginDispatch({...b.meta,eventId});
    if(!await fresh(b)||!await check(b,'dispatch')){await store.mark({...b.meta,state:'unknown'});return denied();}
    try{await dispatch({command:b.command,digest:b.digest,eventId});}catch{await store.mark({...b.meta,state:'unknown'});return unknown();}
    return await reconcileBound(b,{...b.meta,state:'dispatching',eventId},inspectEffects,readEffects);
   }catch{return unknown();}
  },
  async reconcile({execution,approval,inspectEffects,readEffects}){
   let b;try{readEffects=freeze(copy(readEffects));inspectEffects=freeze(copy(inspectEffects));b=await bind(execution,approval,readEffects,inspectEffects);}catch{return denied();}
   if(!await check(b,'beforeLookup')||!await access(b,'beforeLookup','inspect',inspectEffects))return denied();
   let row;try{row=await store.lookup(b.meta);}catch{return unknown();}
   return reconcileBound(b,row,inspectEffects,readEffects);
  }
 });
}
