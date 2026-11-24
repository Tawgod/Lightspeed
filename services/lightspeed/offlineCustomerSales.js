// Offline candidate only. No route or production adapter. Security owns decisions.
import { randomUUID } from 'node:crypto';
import { projectCustomerIdentity } from './customerIdentityEvidence.js';
import { projectSaleWorkflow } from './saleWorkflowEvidence.js';
import { projectReversalEvidence } from './reversalEvidence.js';
import { LightspeedIncompleteReadError } from './readCollection.js';
const id=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const invalid=()=>{throw new LightspeedIncompleteReadError('Invalid integrated evidence.');};
const denied=()=>{const e=new Error('Read not authorized.');e.code='CORE_FORBIDDEN';throw e;};
const unwrap=v=>v&&Object.hasOwn(v,'data')?v.data:v;
const saleOps=['sales.read','sales.payments.read','sales.deposit.read','sales.work-orders.read','fulfillments.read','sales.reversals.read','sales.returns.read','store-credit.read'];
// Unsplit vendor responses may include contact/custom fields. Require broad
// source admission; outputs still use minimal fixed projections.
const customerOps=['customers.read','customers.contacts.read','customers.custom-fields.read','customers.notes.read'];
export function createOfflineCustomerSales({environment,authorize,customers,sales,fulfillments,storeCredit,readLinks,readConsents,readDeposits,readOrders,readReversals,readPickups}={}){
 if(environment!=='test'||typeof authorize!=='function')throw new TypeError('Offline fixture only.');
 function session(actor){
  if(!id(actor?.actorId)||!id(actor?.tenantId))denied();
  const subject=Object.freeze({actorId:actor.actorId,tenantId:actor.tenantId});
  const correlationId=randomUUID(), used=[];
  async function check(operation,resource,phase){
   let ok=false;
   try{ok=await authorize({actor:subject,environment:'test',operation,resource:Object.freeze({...resource}),phase,correlationId});}catch{}
   if(ok!==true)denied();
  }
  async function read(ops,resource,fn){
   for(const op of ops)await check(op,resource,'io');
   const result=await fn({correlationId});
   for(const op of ops)used.push([op,{...resource}]);
   return result;
  }
  async function finish(result){
   for(const [op,resource] of used)await check(op,resource,'projection');
   return {correlationId,data:result};
  }
  return {read,finish};
 }
 return Object.freeze({
  async search(actor,query,{firstPage=true}={}){
   if(typeof query!=='string'||!query.trim()||query.length>256||typeof firstPage!=='boolean')throw new TypeError('Invalid search.');
   const s=session(actor),resource={kind:'customer-search',scope:'all-returned-fields'};
   const ops=['customers.search',...customerOps];
   const result=await s.read(ops,resource,o=>firstPage?customers.searchFirstPage(query,o):customers.search(query,o));
   const rows=firstPage?result?.rows:result;
   if(!Array.isArray(rows))invalid();
   const seen=new Set(),items=rows.map(row=>{
    if(!id(row?.id)||seen.has(row.id))invalid();seen.add(row.id);
    return {customerId:row.id,firstName:typeof row.first_name==='string'?row.first_name:null,lastName:typeof row.last_name==='string'?row.last_name:null};
   });
   // Per-result admission before any output; cannot substitute for source scoping.
   for(const item of items)await s.read(['customers.search','customers.read'],{kind:'customer',id:item.customerId},async()=>null);
   return s.finish({items,coverage:firstPage?'single-page':'search-candidates-only',complete:false,requiresReview:true});
  },
  async identity(actor,customerId,purpose){
   if(!id(customerId)||!id(purpose))throw new TypeError('Exact customer and purpose required.');
   const s=session(actor),resource={kind:'customer',id:customerId};
   const row=unwrap(await s.read(customerOps,resource,o=>customers.get(customerId,o)));
   if(row?.id!==customerId)invalid();
   const links=await s.read(['customers.identity.read'],resource,o=>readLinks(customerId,o));
   const consents=await s.read(['customers.consent.read'],{...resource,purpose},o=>readConsents(customerId,{...o,purpose}));
   if(!Array.isArray(consents)||consents.some(c=>c.purpose!==purpose))invalid();
   return s.finish({...projectCustomerIdentity({customerId,links,consents}),purpose});
  },
  async workflow(actor,saleId){
   if(!id(saleId))throw new TypeError('Exact sale ID required.');
   const s=session(actor),resource={kind:'sale',id:saleId};
   // Raw sale and reversal feeds are not field-filtered. All relevant grants
   // required before either request; no partial success for denied components.
   const sale=unwrap(await s.read(saleOps,resource,o=>sales.get(saleId,o)));
   if(sale?.id!==saleId)invalid();
   const physical=await s.read(['fulfillments.read'],resource,o=>fulfillments.forSale(saleId,o));
   if(!Array.isArray(physical)||physical.some(r=>r?.saleId!==saleId||r.id!==r.raw?.id))invalid();
   const deposits=await s.read(['sales.deposit.read'],resource,o=>readDeposits(saleId,o));
   const orders=await s.read(['sales.work-orders.read'],resource,o=>readOrders(saleId,o));
   const workflow=projectSaleWorkflow({saleId,sale,fulfillments:physical.map(r=>r.raw),depositEvents:deposits,workOrders:orders});
   if(workflow.customerId!==null)await s.read(['customers.read'],{kind:'customer',id:workflow.customerId},async()=>null);
   const events=await s.read(saleOps,resource,o=>readReversals(saleId,o));
   const customerId=workflow.customerId;
   const creditSnapshot=customerId===null?null:unwrap(await s.read(['customers.read','store-credit.read'],{kind:'customer',id:customerId},o=>storeCredit.get(customerId,o)));
   if(customerId!==null&&(!creditSnapshot||typeof creditSnapshot!=='object'||Array.isArray(creditSnapshot)))invalid();
   const reversal=projectReversalEvidence({saleId,workflow,events,creditSnapshot});
   const pickups=await s.read(['fulfillments.read'],resource,o=>readPickups(saleId,o));
   if(!Array.isArray(pickups)||pickups.length>1000)invalid();
   const seen=new Set(),pickupEvidence=pickups.map(p=>{
    if(!id(p?.eventId)||seen.has(p.eventId)||p.saleId!==saleId||customerId===null||p.customerId!==customerId||!['pickup-confirmed','pickup-reversed'].includes(p.kind)||typeof p.quantity!=='string'||!/^\d{1,18}(?:\.\d{1,6})?$/.test(p.quantity)||!/[1-9]/.test(p.quantity)||!workflow.lineItems?.some(l=>l.lineId===p.lineId&&l.productId===p.productId))invalid();
    seen.add(p.eventId);return {eventId:p.eventId,kind:p.kind,lineId:p.lineId,productId:p.productId,quantity:p.quantity,originalEventId:p.originalEventId??null};
   });
   for(const p of pickups){
    if(p.kind==='pickup-reversed'){
     const original=pickups.find(x=>x.eventId===p.originalEventId);
     if(!original||original.kind!=='pickup-confirmed'||original.lineId!==p.lineId||original.productId!==p.productId)invalid();
    }else if(p.originalEventId!=null)invalid();
   }
   return s.finish({workflow,reversal,pickupEvidence,pickupCoverage:'supplied-evidence-only',netPickup:null,executionAuthorized:false});
  }
 });
}
