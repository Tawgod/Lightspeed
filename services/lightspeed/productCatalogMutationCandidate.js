import {fingerprintLightspeedPayload} from './idempotency.js';
import {inspectTypedProductIdentity} from './productIdentity.js';
import {inspectSupplierProductLinks,inspectCatalogReferences} from './catalog.js';
const exact=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const targetOk=t=>exact(t?.productId)&&(t.variantId===null||exact(t.variantId));
const same=(a,b)=>a?.productId===b?.productId&&a?.variantId===b?.variantId;
const fields=new Set(['name','sku','upc','supplierId','supplierSku','categoryId','cost','retail','msrp']);
const money=v=>typeof v==='string'&&/^(0|[1-9]\d{0,17})(\.\d{1,8})?$/.test(v);
const valid=(k,v)=>['cost','retail','msrp'].includes(k)?money(v):exact(v);
const review=reason=>({state:'needs_review',reason,executable:false});
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const only=(v,keys)=>plain(v)&&Object.keys(v).every(k=>keys.includes(k));
const own=(v,k)=>Object.hasOwn(v,k);
// Trusted normalized fixture evidence only. No external side effects or writer.
// A create target is a synthetic reserved ID, not a vendor allocation.
export function prepareCatalogMutation({request,snapshot}={}){
 if(!only(request,['target','desired','expectedVersion','requestId'])||!targetOk(request.target)||
 !exact(request.requestId)||!only(request.desired,[...fields])||!Object.keys(request.desired).length||
 !Object.entries(request.desired).every(([k,v])=>valid(k,v))||!snapshot||
 snapshot.complete!==true||!exact(snapshot.version)||request.expectedVersion!==snapshot.version||
 !Array.isArray(snapshot.products)||!Array.isArray(snapshot.identity)||!Array.isArray(snapshot.links))
 return review('invalid_or_stale_evidence');
 const target={productId:request.target.productId,variantId:request.target.variantId};
 if(snapshot.products.some(p=>!targetOk(p)||!plain(p.values)))return review('malformed_product');
 const keys=snapshot.products.map(p=>JSON.stringify([p.productId,p.variantId]));
 if(new Set(keys).size!==keys.length)return review('duplicate_target');
 const prior=snapshot.products.find(p=>same(p,target));
 const effect=prior?'update':'create';
 if(prior&&prior.active!==true)return review('inactive_or_unknown_target');
 if(!prior&&target.variantId!==null)return review('variant_creation_not_supported');
 const desired={...request.desired};
 const before={},after={};
 for(const k of Object.keys(desired).sort()){
   if(prior&&(!own(prior.values,k)||!valid(k,prior.values[k])))return review('old_value_unresolved');
   if(!prior||prior.values[k]!==desired[k]){before[k]=prior?prior.values[k]:null;after[k]=desired[k];}
 }
 if(!Object.keys(after).length)return review('no_change');
 if(!prior&&(!desired.name||!desired.sku))return review('required_create_fields');
 const effective={...(prior?.values??{}),...desired};
 // Only typed, literal evidence, including inactive records. No fuzzy equality.
 for(const [field,kind] of [['sku','SKU'],['upc','UPC'],['supplierSku','SUPPLIER_SKU']]){
   if(!own(effective,field))continue;
   if(!exact(effective[field]))return review('identifier_unresolved');
   const q={kind,exactValue:effective[field],...(field==='supplierSku'?{supplierId:effective.supplierId}:{})};
   let m;try{m=inspectTypedProductIdentity(q,snapshot.identity,{complete:snapshot.identityComplete===true});}catch{return review('identifier_scope_unresolved');}
   if(!m.complete||!['NO_MATCH','EXACT_UNIQUE'].includes(m.status)||
      m.candidates.some(c=>!prior||!same(c,target)))return review('identifier_collision_or_incomplete');
   if(prior&&!own(after,field)&&m.status!=='EXACT_UNIQUE')return review('existing_identifier_unverified');
 }
 if(!exact(effective.sku))return review('sku_unresolved');
 const refs=inspectCatalogReferences(snapshot.references,{complete:snapshot.referencesComplete===true});
 if(!refs.complete)return review('references_incomplete');
 for(const [k,list] of [['supplierId','suppliers'],['categoryId','categories']]){
   if(own(effective,k)&&!refs.references[list].some(r=>r.id===effective[k]))return review('reference_unresolved');
 }
 // Supplier relationships cannot be implicitly created or reassigned by a product patch.
 if(own(after,'supplierId')||own(after,'supplierSku'))return review('separate_supplier_mapping_review');
 if(prior&&own(effective,'supplierId')){
   const links=inspectSupplierProductLinks(target,snapshot.links,{complete:snapshot.linksComplete===true});
   if(!links.complete||!links.links.some(l=>l.supplierId===effective.supplierId&&l.supplierSku===effective.supplierSku))
     return review('supplier_mapping_unresolved');
 }
 const changedFields=Object.keys(after);
 const operations=['catalog.product.'+effect,...(own(after,'cost')?['catalog.product.cost.modify']:[])];
 const plan={requestId:request.requestId,target,effect,version:snapshot.version,before,after,changedFields,operations};
 return {state:'review_required',plan,fingerprint:fingerprintLightspeedPayload(plan),executable:false};
}
// Verify approval is bound to exact plan; no permission assertion is minted.
export async function inspectCatalogMutationApproval({proposal,approval,authorize,context}={}){
 if(proposal?.state!=='review_required'||proposal.executable!==false||!hash(proposal.fingerprint)||
 !exact(approval?.reviewRef)||approval.fingerprint!==proposal.fingerprint||typeof authorize!=='function')
 return review('approval_unresolved');
 const p=proposal.plan;
 if(!p||!targetOk(p.target)||!['create','update'].includes(p.effect)||!plain(p.after)||
 !Object.keys(p.after).length||!Object.entries(p.after).every(([k,v])=>fields.has(k)&&valid(k,v))||
 fingerprintLightspeedPayload(p)!==proposal.fingerprint)return review('proposal_changed');
 // Derive again from normalized effects, never accept client-provided grant list.
 const ops=['catalog.product.'+p.effect,...(own(p.after,'cost')?['catalog.product.cost.modify']:[]),
 'catalog.product.'+p.effect+'.approve','catalog.product.'+p.effect+'.execute'];
 for(const operation of ops){
   try{if(await authorize({operation,resource:{...p.target},fields:operation.endsWith('cost.modify')?['cost']:Object.keys(p.after).sort(),context,environment:'test',mode:'execute'})!==true)return review('operation_denied');}
   catch{return review('operation_denied');}
 }
 return {state:'fixture_checks_passed',executable:false};
}
// Classifies supplied remote outcome evidence only; never calls a vendor or retries.
export function inspectCatalogReadback({proposal,observation}={}){
 const p=proposal?.plan;
 const unknown=()=>({state:'unknown',retryAllowed:false,executable:false});
 if(proposal?.state!=='review_required'||!p||!hash(proposal.fingerprint)||
 fingerprintLightspeedPayload(p)!==proposal.fingerprint||
 observation?.complete!==true||observation?.fingerprint!==proposal.fingerprint||
 !same(observation,p.target)||!exact(observation.version)||observation.version===p.version||
 !plain(observation.values)||!Object.entries(p.after).every(([k,v])=>own(observation.values,k)&&observation.values[k]===v))return unknown();
 return {state:'verified_evidence',retryAllowed:false,executable:false};
}
