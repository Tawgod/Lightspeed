// Catalog-owned isolated HC-CORE-ADAPTER/0.1 consumer. No routes or vendor writer.
import {prepareCatalogMutation,inspectCatalogReadback} from './productCatalogMutationCandidate.js';
import {prepareRemoteExecutionM7} from './remoteMutationM7.js';
import {createRemoteDomainAdapterM10} from './domainAdapterM10.js';
import {fingerprintLightspeedPayload as hash} from './idempotency.js';
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const literal=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const copy=v=>{hash(v);return structuredClone(v)};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v};
const same=(a,b)=>a.productId===b.productId&&a.variantId===b.variantId;
const canonical=v=>v.includes('.')?v.replace(/0+$/,'').replace(/\.$/,''):v;
const priceFields=['cost','retail','msrp'];
const effect=(operation,target,location,field,supplierId=null)=>({operation,target,location,field,supplierId});
// Trusted evidence (not HTTP input): exact normalized snapshot and source metadata.
// Currency applies to the admitted master price patch, never a supplier or PO write.
export function deriveCatalogIntentM12({tenant,actor,request,evidence}={}){
 if(!exact(evidence,['tenant','environment','location','currency','evidenceRef','snapshot'])||evidence.tenant!==tenant||evidence.environment!=='test'||!literal(evidence.location)||!literal(evidence.evidenceRef)||!exact(request,['target','desired','requestId','expectedVersion'])||!exact(request.target,['productId','variantId']))throw Error('Catalog evidence not admitted');
 if(!exact(actor,['id','realm','tenant'])||actor.realm!=='employee'||actor.tenant!==tenant)throw Error('Actor not admitted');
 const snapshot=copy(evidence.snapshot);
 const proposal=prepareCatalogMutation({request:copy(request),snapshot});
 if(proposal.state!=='review_required')throw Error('Catalog review required');
 const p=proposal.plan,t=p.target,prior=snapshot.products.find(x=>same(x,t));
 const before=prior?.values??{},after={...before,...p.after};
 const monetary=Object.keys(p.after).some(k=>priceFields.includes(k));
 if(monetary&&!/^[A-Z]{3}$/.test(evidence.currency??''))throw Error('Currency not admitted');
 if(monetary&&Object.entries(p.after).some(([k,v])=>priceFields.includes(k)&&!/^(0|[1-9][0-9]{0,11})(\.[0-9]{0,5}[1-9])?$/.test(canonical(v))))throw Error('Unsupported precision');
 const keys=[['target',t.productId,t.variantId]];
 if(prior)keys.push(['revision',t.productId,t.variantId,p.version]);
 for(const v of [before,after]){
  if(v.sku!==undefined)keys.push(['sku',v.sku]);
  if(v.upc!==undefined)keys.push(['upc',v.upc]);
  if(v.supplierSku!==undefined){if(!literal(v.supplierId))throw Error('Supplier not admitted');keys.push(['supplierSku',v.supplierId,v.supplierSku]);}
 }
 const reservationKeys=[...new Map(keys.map(k=>[JSON.stringify(k),k])).values()];
 const op='catalog.product.'+p.effect;
 const e=(operation,field,supplierId=null)=>effect(operation,t,evidence.location,field,supplierId);
 const effects=Object.keys(p.after).flatMap(field=>[e(op,field),e(op+'.approve',field),e(op+'.execute',field),...(field==='cost'?[e('catalog.product.cost.modify',field),...(after.supplierId?[e('catalog.product.cost.modify',field,after.supplierId)]:[])]:[])]);
 const execution=prepareRemoteExecutionM7({tenant,key:p.requestId,actor,target:t,predecessor:prior?p.version:null,values:p.after,effects,reservationKeys});
 const readEffects=[e('catalog.product.read','eventId'),e('catalog.product.read','revision')],inspectEffects=[e('fixture.reconcile','receipt')];
 const rich=x=>{
  const amount=priceFields.includes(x.field)&&Object.hasOwn(execution.values,x.field)?canonical(execution.values[x.field]):null;
  return {operation:x.operation,tenant,environment:'test',location:x.location,resourceType:'product',resourceId:t.productId,field:x.field,revision:execution.predecessor,relationships:[...(t.variantId===null?[]:[{type:'variant',id:t.variantId}]),...(x.supplierId===null?[]:[{type:'supplier',id:x.supplierId}])],quantity:null,amount,currency:amount===null?null:evidence.currency,purpose:null,audience:null};
 };
 const facts={evidenceRef:evidence.evidenceRef,executionEffects:execution.effects.map(rich),readEffects:readEffects.map(rich),inspectEffects:inspectEffects.map(rich)};
 return freeze(copy({execution,proposal,readEffects,inspectEffects,facts,request,sourceDigest:hash([evidence.tenant,evidence.environment,evidence.location,monetary?evidence.currency:null,evidence.evidenceRef,proposal.fingerprint])}));
}
// Constructor-owned trusted callbacks. readOriginal must retrieve immutable intent +
// ORIGINAL approval by key; readFresh independently reads current normalized evidence.
// No mutable in-module cache or authority issued by this adapter.
export function createCatalogDomainAdapterM12({tenant,resolveActor,readOriginal,readFresh,authorizationOptions,store,dispatch,observe,clock}={}){
 if(![resolveActor,readOriginal,readFresh,dispatch,observe,clock].every(f=>typeof f==='function')||!authorizationOptions||authorizationOptions.clock!==clock)throw TypeError('Trusted Catalog adapters required');
 async function original(key,actor){
  const r=freeze(copy(await readOriginal({tenant,key,actor})));
  if(!exact(r,['request','evidence','approval','actor'])||hash(r.actor)!==hash(actor)||r.request.requestId!==key)throw Error('Original intent not admitted');
  const d=deriveCatalogIntentM12({tenant,actor,request:r.request,evidence:r.evidence});
  const a=r.approval;
  if(!exact(a,['reference','executionDigest','reviewerId','expiresAt'])||a.executionDigest!==hash(d.execution)||!literal(a.reference)||!literal(a.reviewerId)||a.reviewerId===actor.id||!Number.isSafeInteger(a.expiresAt)||a.expiresAt<=clock())throw Error('Original approval not admitted');
  return {d,a,r};
 }
 const deriveScope=async({command,digest,reads,inspects})=>{
  const {d}=await original(command.key,command.actor);
  if(hash(command)!==hash(d.execution)||digest!==hash(d.execution)||hash(reads)!==hash(d.readEffects)||hash(inspects)!==hash(d.inspectEffects))throw Error('Scope not admitted');
  return d.facts;
 };
 const adapter=createRemoteDomainAdapterM10({tenant,resolveActor,authorizationOptions:{...authorizationOptions,deriveScope},store,
  resolvePrepared:async({request,actor})=>{
   if(!exact(request,['requestId'])||!literal(request.requestId))throw Error('Request not admitted');
   const {d,a}=await original(request.requestId,actor);
   return {execution:d.execution,approval:a,readEffects:d.readEffects,inspectEffects:d.inspectEffects};
  },
  deriveFresh:async command=>{
   const {d,r}=await original(command.key,command.actor);
   const fresh=deriveCatalogIntentM12({tenant,actor:command.actor,request:r.request,evidence:await readFresh({tenant,key:command.key,target:command.target,actor:command.actor})});
   if(fresh.sourceDigest!==d.sourceDigest||hash(fresh.facts)!==hash(d.facts))return null;
   return fresh.execution;
  },
  dispatch,
  observe:async args=>{
   const {d}=await original(args.command.key,args.command.actor);
   const o=await observe(args);
   if(!o||inspectCatalogReadback({proposal:d.proposal,observation:{...o.target,complete:o.complete,fingerprint:d.proposal.fingerprint,version:o.revision,values:o.values}}).state!=='verified_evidence')return null;
   return o;
  }
 });
 return adapter;
}
