// HC-CORE-ADAPTER/0.1: opt-in server-side synthetic composition, not a route or policy engine.
import {fingerprintLightspeedPayload as hash} from './idempotency.js';
import {prepareExecutionM7} from './localTransactionM7.js';
import {prepareRemoteExecutionM7} from './remoteMutationM7.js';
import {createAuthorizationM8,createLocalTransactionM8,createRemoteMutationM8} from './authorizationM8.js';
export const VERSION='HC-CORE-ADAPTER/0.1';
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const snapshot=v=>{hash(v);return freeze(JSON.parse(JSON.stringify(v)));};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const outcome=state=>Object.freeze({state,retryAllowed:false});
const denied=()=>outcome('undisclosed');
const unknown=()=>outcome('unknown');
// Trusted callbacks are constructor-owned; request/context never supply a writer, evaluator or prepared bundle.
function admission({tenant,resolvePrepared,resolveActor,authorizationOptions},remote){
 if(typeof tenant!=='string'||!tenant||typeof resolvePrepared!=='function'||typeof resolveActor!=='function'||!authorizationOptions||typeof authorizationOptions.deriveScope!=='function')throw TypeError('Trusted domain adapters required');
 const authorization=createAuthorizationM8(authorizationOptions);
 return {authorization,async prepare(context,request,mode){
  const input=snapshot(request);
  const actor=snapshot(await resolveActor(context));
  if(actor.realm!=='employee'||actor.tenant!==tenant)throw Error('Admission refused');
  const b=snapshot(await resolvePrepared({context,request:input,mode,actor}));
  const inspect=remote?'inspectEffects':'reconcileEffects';
  if(!exact(b,['execution','approval','readEffects',inspect]))throw Error('Admission refused');
  const c=b.execution;
  const {version,environment,...raw}=c;
  const prepared=remote?prepareRemoteExecutionM7(raw):prepareExecutionM7(raw);
  if(c.tenant!==tenant||hash(c)!==hash(prepared)||hash(c.actor)!==hash(actor)||b.approval?.executionDigest!==hash(c)||!Array.isArray(b.readEffects)||!b.readEffects.length||!Array.isArray(b[inspect])||!b[inspect].length)throw Error('Admission refused');
  return b;
 }};
}
export function createLocalDomainAdapterM10({tenant,resolvePrepared,resolveActor,authorizationOptions,verifyExecution,apply,transaction,auditDenied,inspectCommitted,receiptSchema,projectResult}={}){
 if(typeof verifyExecution!=='function'||typeof apply!=='function')throw TypeError('Trusted local domain functions required');
 const a=admission({tenant,resolvePrepared,resolveActor,authorizationOptions},false);
 const run=createLocalTransactionM8({tenant,authorization:a.authorization,transaction,auditDenied,inspectCommitted,receiptSchema,projectResult});
 return Object.freeze({async run({context,request}={}){
  let b;try{b=await a.prepare(context,request,'local');}catch{return denied();}
  try{
   const r=await run({...b,verifyExecution,apply});
   return freeze({state:'verified',retryAllowed:false,replayed:r.replayed,result:snapshot(r.result)});
  }catch(e){
   if(e?.code==='CORE_FORBIDDEN')return denied();
   if(e?.code==='CORE_REVISION_CONFLICT')return outcome('revision_conflict');
   // Arbitrary adapter errors and uncertain commit are not proof of rollback.
   return unknown();
  }
 }});
}
export function createRemoteDomainAdapterM10({tenant,resolvePrepared,resolveActor,authorizationOptions,store,deriveFresh,dispatch,observe}={}){
 const a=admission({tenant,resolvePrepared,resolveActor,authorizationOptions},true);
 const engine=createRemoteMutationM8({tenant,authorization:a.authorization,store,deriveFresh,dispatch,observe});
 async function invoke(mode,{context,request}={}){
  let b;try{b=await a.prepare(context,request,mode);}catch{return denied();}
  try{
   const r=await engine[mode](b);
   if(r.state==='denied')return denied();
   if(r.state==='unknown'||r.state==='conflict')return outcome(r.state);
   if(r.state==='verified')return freeze({state:'verified',retryAllowed:false,result:snapshot(r.result)});
   return unknown();
  }catch{return unknown();}
 }
 return Object.freeze({run:input=>invoke('run',input),reconcile:input=>invoke('reconcile',input)});
}
