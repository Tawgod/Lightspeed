// Isolated Customer & Sales evidence candidate. No financial or inventory writer.
import {prepareExecutionM7} from './localTransactionM7.js';
import {createLocalTransactionM8} from './authorizationM8.js';
import {fingerprintLightspeedPayload as fp} from './idempotency.js';
import {assessCumulativeEvidence} from './customerSalesM9.js';

const fail=()=>{throw Error('Invalid customer evidence fixture');};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(v)&&v!=='unknown';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const canonical=v=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(v))fail();const [a,b='']=v.split('.');const n=b.replace(/0+$/,'');return n?a+'.'+n:a;};
const units=v=>{const [a,b='']=canonical(v).split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));};
const currency=v=>typeof v==='string'&&/^[A-Z]{3}$/.test(v);
const operation=Object.freeze({
 'payment-reversal':'sales.payments.reverse','deposit-reversal':'sales.deposit.reverse','credit-reversal':'store-credit.reverse',
 pickup:'fulfillments.pickup.confirm','pickup-reversal':'fulfillments.pickup.reverse',return:'sales.returns.execute',
 settlement:'fixture.customer.settlement.evidence',refund:'fixture.customer.refund.evidence',
 'credit-issue':'fixture.customer.credit-issue.evidence',fulfillment:'fixture.customer.fulfillment.evidence'
});
const legacyKinds=new Set(['payment-reversal','deposit-reversal','credit-reversal','pickup','pickup-reversal','return']);
const physical=new Set(['pickup','pickup-reversal','return','fulfillment']);
const financialKinds=Object.freeze({'payment-reversal':['payment'],'deposit-reversal':['deposit'],'credit-reversal':['credit'],settlement:['payment','deposit'],refund:['payment','deposit'],'credit-issue':['payment','deposit']});
const eventKeys=['eventId','sourceId','saleId','customerId','orderId','ledgerId','kind','targetId','originalTransactionId','originalEventId','productId','quantity','amount','currency'];
function validateEvent(e){
 if(!exact(e,eventKeys)||!['eventId','sourceId','saleId','customerId','orderId','ledgerId','targetId'].every(k=>id(e[k]))||!Object.hasOwn(operation,e.kind))fail();
 if(physical.has(e.kind)){
  if(e.originalTransactionId!==null||!id(e.productId)||e.amount!==null||e.currency!==null||units(e.quantity)<=0n)fail();
  if(e.kind==='pickup-reversal'?!id(e.originalEventId):e.originalEventId!==null)fail();
 }else if(e.originalTransactionId!==e.targetId||e.originalEventId!==null||e.productId!==null||e.quantity!==null||!currency(e.currency)||units(e.amount)<=0n)fail();
 return e;
}
const targetOf=e=>({type:'sale',id:e.saleId});
const effect=(operation,target,location,fields)=>({operation,target,location,fields});
const effects=(e,location)=>[effect(operation[e.kind],targetOf(e),location,['evidence']),effect('fixture.customer.evidence.record',targetOf(e),location,['source'])];
export function prepareCustomerEvidenceM11({tenant,actor,key,location,revision,event}={}){
 validateEvent(event);
 if(!id(tenant)||!id(location)||!Number.isSafeInteger(revision)||revision<1)fail();
 return prepareExecutionM7({tenant,scope:'test.customer.evidence.m11',key,actor,targets:[targetOf(event)],effects:effects(event,location),expectedRevisions:[{target:targetOf(event),revision}],payload:{event,location}});
}
function checkCommand(command){
 const {event,location}=command.payload;
 const expected=prepareCustomerEvidenceM11({tenant:command.tenant,actor:command.actor,key:command.key,location,revision:command.expectedRevisions[0]?.revision,event});
 if(fp(command)!==fp(expected))fail();
 return event;
}
// Trusted fixture wiring only. Rich scope must also be independently admitted by
// Security; deriving it here is NOT independent authorization or evidence admission.
export function deriveCustomerScopeM11({command,reads,inspects,evidenceRef}){
 const e=checkCommand(command);
 if(!id(evidenceRef))fail();
 const relationships=[['customer',e.customerId],['sale',e.saleId],['order',e.orderId],['ledger',e.ledgerId],['event',e.eventId],['source',e.sourceId],['target',e.targetId]];
 if(e.originalTransactionId!==null)relationships.push(['original-transaction',e.originalTransactionId]);
 if(e.originalEventId!==null)relationships.push(['original-event',e.originalEventId]);
 if(e.productId!==null)relationships.push(['product',e.productId]);
 const map=es=>es.flatMap(x=>x.fields.map(field=>({operation:x.operation,tenant:command.tenant,environment:'test',location:x.location,resourceType:x.target.type,resourceId:x.target.id,field,revision:String(command.expectedRevisions[0].revision),relationships:relationships.map(([type,id])=>({type,id})),quantity:e.quantity===null?null:canonical(e.quantity),amount:e.amount===null?null:canonical(e.amount),currency:e.currency,purpose:'customer-evidence',audience:'employee'})));
 return {evidenceRef,executionEffects:map(command.effects),readEffects:map(reads),inspectEffects:map(inspects)};
}
export function customerEvidenceAccessM11(command){
 const e=checkCommand(command),location=command.payload.location,target=targetOf(e);
 return {readEffects:[effect('fixture.customer.evidence.read',target,location,['id'])],reconcileEffects:[effect('fixture.customer.evidence.inspect',target,location,['id'])]};
}
// Complete synthetic single-sale evidence only. Allocations are explicit trusted
// facts, not inferred from payment/deposit/credit labels or a vendor status.
export function nextCustomerEvidenceM11(command,evidence){
 const e=checkCommand(command),row=evidence[0]?.row,r=row?.record;
 if(evidence.length!==1||fp(evidence[0].target)!==fp(targetOf(e))||!r||r.tenant!==command.tenant||r.location!==command.payload.location||r.revision!==String(row.revision)||row.revision!==command.expectedRevisions[0].revision||r.complete!==true)fail();
 if(['saleId','customerId','orderId'].some(k=>r[k]!==e[k])||!Array.isArray(r.sources)||!Array.isArray(r.allocations)||!Array.isArray(r.buckets)||!Array.isArray(r.events))fail();
 const events=[...r.events,e],eventIds=new Set(),sourceIds=new Set(),spent=new Map(),originalSpent=new Map(),fulfilled=new Map();
 const originals=new Map(),buckets=new Map(),allocations=new Map(),sources=new Map();
 for(const [type,rows] of [['payment',r.payments],['deposit',r.deposits],['credit',r.credits]]){
  if(!Array.isArray(rows))fail();
  for(const o of rows){const k=JSON.stringify([type,o.id]);if(!id(o.id)||originals.has(k)||o.saleId!==r.saleId||o.customerId!==r.customerId||o.sourceConfirmed!==true||!currency(o.currency))fail();units(o.amount);originals.set(k,o);}
 }
 for(const b of r.buckets){if(!id(b.id)||buckets.has(b.id)||!currency(b.currency)||!['settlement','disbursement'].includes(b.kind))fail();units(b.amount);buckets.set(b.id,b);}
 for(const a of r.allocations){const k=JSON.stringify([a.type,a.targetId,a.ledgerId,a.kind]);if(allocations.has(k)||!id(a.ledgerId)||!originals.has(JSON.stringify([a.type,a.targetId]))||!buckets.has(a.bucketId)||!['settlement','disbursement'].includes(a.kind)||buckets.get(a.bucketId).kind!==a.kind)fail();allocations.set(k,a);}
 for(const s of r.sources){validateEvent(s.event);if(s.confirmed!==true||sources.has(s.event.sourceId))fail();sources.set(s.event.sourceId,s.event);}
 for(const x of events){
  validateEvent(x);
  if(['saleId','customerId','orderId'].some(k=>r[k]!==x[k])||eventIds.has(x.eventId)||sourceIds.has(x.sourceId)||!sources.has(x.sourceId)||fp(sources.get(x.sourceId))!==fp(x))fail();
  eventIds.add(x.eventId);sourceIds.add(x.sourceId);
  if(physical.has(x.kind)){
   const l=r.lines.find(l=>l.id===x.targetId);
   if(!l||l.productId!==x.productId||l.ledgerId!==x.ledgerId)fail();
   if(x.kind==='fulfillment'){const n=(fulfilled.get(l.id)??0n)+units(x.quantity);if(n>units(l.quantity))fail();fulfilled.set(l.id,n);}
   continue;
  }
  const kind=x.kind==='settlement'?'settlement':'disbursement';
  const types=financialKinds[x.kind];
  const matching=types.map(type=>({type,a:allocations.get(JSON.stringify([type,x.targetId,x.ledgerId,kind]))})).filter(v=>v.a);
  if(matching.length!==1)fail();
  const {type,a}=matching[0],o=originals.get(JSON.stringify([type,x.targetId])),b=buckets.get(a.bucketId);
  if(o.currency!==x.currency||b.currency!==x.currency)fail();
  const n=units(x.amount),originalKey=JSON.stringify([type,x.targetId,kind]);
  const total=(originalSpent.get(originalKey)??0n)+n,group=(spent.get(b.id)??0n)+n;
  if(total>units(o.amount)||group>units(b.amount))fail();
  originalSpent.set(originalKey,total);spent.set(b.id,group);
 }
 // Retain all previously accepted cumulative pickup/reversal/return checks.
 // A fulfillment observation does not add to pickup, and no event implies stock.
 assessCumulativeEvidence({...r,events:events.filter(x=>legacyKinds.has(x.kind)).map((x,i)=>({...x,sequence:i+1})),coverage:{saleId:r.saleId,customerId:r.customerId,revision:r.revision,complete:true}});
 return {...r,events,revision:String(row.revision+1)};
}
export function createCustomerEvidenceM11({authorization,tenant,transaction,auditDenied,inspectCommitted}={}){
 const run=createLocalTransactionM8({authorization,tenant,transaction,auditDenied,inspectCommitted,receiptSchema:{version:'customer.evidence.m11',fields:['id','revision']},projectResult:r=>({id:r.id})});
 return ({execution,approval})=>run({execution,approval,...customerEvidenceAccessM11(execution),
  verifyExecution:({command,evidence})=>{try{nextCustomerEvidenceM11(command,evidence);return true;}catch{return false;}},
  apply:async(tx,command,evidence)=>({id:command.payload.event.eventId,revision:await tx.replaceDomain({...targetOf(command.payload.event),expectedRevision:evidence[0].row.revision,record:nextCustomerEvidenceM11(command,evidence)})})
 });
}
