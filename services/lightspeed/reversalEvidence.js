// Supplied evidence only; no posting, refund, inventory or authorization effects.
import { LightspeedIncompleteReadError } from './readCollection.js';
const fail=()=>{throw new LightspeedIncompleteReadError('Invalid reversal evidence.');};
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const exact=v=>{if(!id(v))fail();return v;};
const amount=v=>typeof v==='string'&&/^\d{1,18}(?:\.\d{1,6})?$/.test(v)&&/[1-9]/.test(v);
const currency=v=>typeof v==='string'&&/^[A-Z]{3}$/.test(v);
const list=v=>{if(!Array.isArray(v)||v.length>1000)fail();return v;};
function index(rows,key){
 const map=new Map();
 for(const row of list(rows)){if(!obj(row)||!id(row[key])||map.has(row[key]))fail();map.set(row[key],row);}
 return map;
}
const optional=(row,key,map)=>{
 if(row[key]==null)return null;
 const value=exact(row[key]);
 if(!map.has(value))fail();
 return value;
};
export function projectReversalEvidence({saleId,workflow,creditSnapshot=null,events=[]}={}){
 if(!id(saleId))throw new TypeError('Exact sale ID required.');
 if(!obj(workflow)||workflow.saleId!==saleId)fail();
 const customerId=workflow.customerId===null?null:exact(workflow.customerId);
 const lines=index(workflow.lineItems??[],'lineId');
 const payments=index(workflow.paymentEvidence??[],'paymentId');
 const deposits=index(workflow.depositEvidence??[],'eventId');
 const orders=index(workflow.workOrderEvidence??[],'workOrderId');
 const fulfillments=index(workflow.fulfillmentEvidence??[],'fulfillmentId');
 const byId=index(events,'eventId');
 const financial=[],physical=[];
 for(const row of byId.values()){
  if(row.saleId!==saleId||row.customerId!==customerId)fail();
  const base={eventId:row.eventId,kind:row.kind,workOrderId:optional(row,'workOrderId',orders)};
  if(row.kind==='merchandise-return'){
   const lineId=exact(row.lineId),line=lines.get(lineId);
   if(!line||line.productId!==row.productId||!amount(row.quantity))fail();
   const fulfillmentId=optional(row,'fulfillmentId',fulfillments);
   if(fulfillmentId&&!fulfillments.get(fulfillmentId).lines?.some(l=>l.lineId===lineId&&l.productId===row.productId&&l.association==='source-confirmed'))fail();
   physical.push({...base,lineId,productId:row.productId,quantity:row.quantity,fulfillmentId,stockEffect:null});
   continue;
  }
  if(!['sale-void','payment-reversal','deposit-reversal','credit-issued','credit-reversal'].includes(row.kind))fail();
  if(row.lineId!=null||row.fulfillmentId!=null||row.quantity!=null||row.productId!=null)fail();
  if(row.kind==='sale-void'){
   if(row.amount!=null||row.currency!=null||row.paymentId!=null||row.depositEventId!=null||row.originalEventId!=null)fail();
   financial.push(base);continue;
  }
  if(!amount(row.amount)||!currency(row.currency))fail();
  const paymentId=optional(row,'paymentId',payments),depositEventId=optional(row,'depositEventId',deposits);
  if(row.kind==='payment-reversal'&&!paymentId)fail();
  if(row.kind==='deposit-reversal'&&(!depositEventId||deposits.get(depositEventId).kind!=='deposit-recorded'||deposits.get(depositEventId).currency!==row.currency))fail();
  if(row.kind.startsWith('credit-')&&!customerId)fail();
  let originalEventId=null;
  if(row.kind==='credit-reversal'){
   originalEventId=exact(row.originalEventId);
   const original=byId.get(originalEventId);
   if(!original||original.kind!=='credit-issued'||original.saleId!==saleId||original.customerId!==customerId||original.currency!==row.currency)fail();
  }else if(row.originalEventId!=null)fail();
  financial.push({...base,amount:row.amount,currency:row.currency,paymentId,depositEventId,originalEventId});
 }
 let balance=null;
 if(creditSnapshot!==null){
  if(!obj(creditSnapshot)||!customerId)fail();
  if(creditSnapshot.customer!=null&&!obj(creditSnapshot.customer))fail();
  const ids=[creditSnapshot.customer_id,creditSnapshot.customer?.id].filter(x=>x!=null);
  if(ids.some(x=>x!==customerId))fail();
  // A request-scoped response alone is not verified customer ownership.
  if(ids.length&&typeof creditSnapshot.amount==='string'&&/^-?\d{1,18}(?:\.\d{1,6})?$/.test(creditSnapshot.amount)&&currency(creditSnapshot.currency))
   balance={amount:creditSnapshot.amount,currency:creditSnapshot.currency,association:'source-confirmed'};
 }
 return {saleId,customerId,financial,physical,balance,coverage:'supplied-evidence-only',complete:false,netRefund:null,netCredit:null,stockAdjustment:null,executionAuthorized:false};
}
export function createReversalEvidenceRead({workflow,readEvents,storeCredit}={}){
 if(typeof workflow?.get!=='function'||typeof readEvents!=='function'||typeof storeCredit?.get!=='function')throw new TypeError('Injected read services required.');
 return Object.freeze({async get(saleId,{correlationId}={}){
  if(!id(saleId))throw new TypeError('Exact sale ID required.');
  const options=correlationId===undefined?[]:[{correlationId}];
  const record=await workflow.get(saleId,...options);
  if(!obj(record)||record.saleId!==saleId)fail();
  const customerId=record.customerId===null?null:exact(record.customerId);
  const events=await readEvents(saleId,...options);
  const body=customerId===null?null:await storeCredit.get(customerId,...options);
  const creditSnapshot=obj(body)&&Object.hasOwn(body,'data')?body.data:body;
  if(customerId!==null&&!obj(creditSnapshot))fail();
  return projectReversalEvidence({saleId,workflow:record,events,creditSnapshot});
 }});
}
