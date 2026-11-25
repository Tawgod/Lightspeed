// HC-CUSTOMER-EVIDENCE/0.1 isolated domain adapter; never a financial/stock writer.
import {createLocalDomainAdapterM10} from './domainAdapterM10.js';
import {prepareExecutionM7} from './localTransactionM7.js';
import {fingerprintLightspeedPayload as hash} from './idempotency.js';
import {prepareCustomerEvidenceM11,nextCustomerEvidenceM11,deriveCustomerScopeM11} from './customerSalesM11.js';
const fail=()=>{throw Error('Invalid customer evidence intent')};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(x)&&x!=='unknown';
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const copy=x=>JSON.parse(JSON.stringify(x));
const same=(a,b)=>hash(a)===hash(b);
const target=(type,parts)=>({type,id:hash(parts)});
const key=t=>JSON.stringify([t.type,t.id]);
const units=x=>{if(typeof x!=='string'||!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(x))fail();const [a,b='']=x.split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'))};
const fmt=n=>{const s=n.toString().padStart(7,'0');return s.slice(0,-6)+(s.slice(-6).replace(/0+$/,'')?'.'+s.slice(-6).replace(/0+$/,''):'')};
const financial=e=>e.amount!==null;
const bucketKind=e=>e.kind==='settlement'?'settlement':'disbursement';
// A tenant-isolated source namespace excludes sale, ledger and outlet so reuse
// across those aggregates conflicts. Provider/account identity is trusted, not guessed.
export function customerTargetsM12({tenant,event,source,allocation}){
 const ns=[tenant,'test'];
 const sale={type:'sale',id:event.saleId};
 const claim=target('customer.source',[...ns,source.system,source.account,source.eventId]);
 const occurrence=target('customer.event',[...ns,event.eventId]);
 if(!financial(event))return {sale,claim,occurrence};
 const group=target('customer.allocation',[...ns,allocation.groupId]);
 const original=target('customer.original',[...ns,source.system,source.account,source.transactionId,allocation.originalType,allocation.kind]);
 return {sale,claim,occurrence,group,original};
}
function validate(intent){
 if(!exact(intent,['tenant','location','event','source','allocation','snapshots','approvalRef','evidenceRef'])||![intent.tenant,intent.location,intent.approvalRef,intent.evidenceRef].every(id))fail();
 const {event:e,source:s,allocation:a}=intent;
 if(!exact(s,['system','account','eventId','transactionId','revision','outlet','confirmed','eventDigest'])||![s.system,s.account,s.eventId,s.revision,s.outlet].every(id)||s.confirmed!==true||s.outlet!==intent.location||s.eventId!==e.sourceId||s.eventDigest!==hash(e))fail();
 if(financial(e)){
  if(!id(s.transactionId)||!exact(a,['groupId','kind','originalType','originalId','currency','amount','originalAmount'])||!id(a.groupId)||!['payment','deposit','credit'].includes(a.originalType)||a.originalId!==e.originalTransactionId||a.kind!==bucketKind(e)||a.currency!==e.currency||units(a.amount)<units(e.amount)||units(a.originalAmount)<units(e.amount))fail();
 }else if(a!==null||s.transactionId!==null)fail();
}
export function prepareCustomerM12({intent,actor,key:requestKey}){
 validate(intent);const i=copy(intent),e=i.event,ts=customerTargetsM12(i),sn=i.snapshots;
 if(!Array.isArray(sn)||sn.length!==Object.keys(ts).length||new Set(sn.map(x=>key(x.target))).size!==sn.length)fail();
 const row=t=>{const s=sn.find(x=>key(x.target)===key(t));if(!s||!same(s.target,t)||!exact(s,['target','row']))fail();return s.row};
 const saleRow=row(ts.sale);
 if(!saleRow||!Number.isSafeInteger(saleRow.revision)||row(ts.claim)!==null||row(ts.occurrence)!==null)fail();
 const legacy=prepareCustomerEvidenceM11({tenant:i.tenant,actor,key:requestKey,location:i.location,revision:saleRow.revision,event:e});
 const next=nextCustomerEvidenceM11(legacy,[{target:ts.sale,row:saleRow}]);
 const writes=[{target:ts.sale,record:next},{target:ts.claim,record:{tenant:i.tenant,source:i.source,event:e,approvalRef:i.approvalRef}},{target:ts.occurrence,record:{tenant:i.tenant,sourceId:e.sourceId,saleId:e.saleId,eventDigest:hash(e)}}];
 if(financial(e)){
  const a=i.allocation,r=saleRow.record;
  const local=r.allocations.filter(x=>x.type===a.originalType&&x.targetId===a.originalId&&x.ledgerId===e.ledgerId&&x.kind===a.kind);
  const originalRows=({payment:r.payments,deposit:r.deposits,credit:r.credits})[a.originalType];
  const orig=originalRows.find(x=>x.id===a.originalId);
  const localBucket=r.buckets.find(x=>x.id===local[0]?.bucketId);
  if(local.length!==1||!orig||!localBucket||orig.currency!==a.currency||units(orig.amount)!==units(a.originalAmount)||localBucket.currency!==a.currency||localBucket.kind!==a.kind)fail();
  // Shared bucket and original transaction capacity must exist independently
  // before recording. No creation of financial capacity from caller evidence.
  for(const [t,identity,limit] of [
   [ts.group,{groupId:a.groupId,kind:a.kind,currency:a.currency},a.amount],
   [ts.original,{system:i.source.system,account:i.source.account,transactionId:i.source.transactionId,originalType:a.originalType,kind:a.kind,currency:a.currency},a.originalAmount]
  ]){
   const prior=row(t),r=prior?.record;
   if(!prior||!exact(r,['tenant','identity','limit','used'])||r.tenant!==i.tenant||!same(r.identity,identity)||units(r.limit)!==units(limit))fail();
   const total=units(r.used)+units(e.amount);if(total>units(r.limit))fail();
   writes.push({target:t,record:{...r,used:fmt(total)}});
  }
 }
 const effects=[...legacy.effects,...Object.entries(ts).filter(([n])=>n!=='sale').map(([n,t])=>({operation:'fixture.customer.evidence.record',target:t,location:i.location,fields:[n]}))];
 const execution=prepareExecutionM7({tenant:i.tenant,scope:'test.customer.evidence.m12',key:requestKey,actor,targets:Object.values(ts),effects,expectedRevisions:Object.values(ts).map(t=>({target:t,revision:row(t)?.revision??null})),payload:{intent:i,writes}});
 return {execution,readEffects:[{operation:'fixture.customer.evidence.read',target:ts.sale,location:i.location,fields:['id']}],reconcileEffects:[{operation:'fixture.customer.evidence.inspect',target:ts.sale,location:i.location,fields:['id']}]};
}
function replan(c){const p=prepareCustomerM12({intent:c.payload.intent,actor:c.actor,key:c.key});if(!same(p.execution,c))fail();return p}
export function deriveCustomerScopeM12({command,reads,inspects}){
 replan(command);const i=command.payload.intent,e=i.event;
 const rel=[['customer',e.customerId],['sale',e.saleId],['order',e.orderId],['ledger',e.ledgerId],['event',e.eventId],['source',e.sourceId],['source-system',i.source.system],['source-account',i.source.account],['source-revision',i.source.revision],['source-digest',i.source.eventDigest],['target',e.targetId]];
 if(financial(e))rel.push(['provider-transaction',i.source.transactionId],['original-transaction',e.originalTransactionId],['allocation-group',i.allocation.groupId],['allocation-kind',i.allocation.kind],['original-type',i.allocation.originalType]);
 if(e.originalEventId!==null)rel.push(['original-event',e.originalEventId]);
 if(e.productId!==null)rel.push(['product',e.productId]);
 const map=es=>es.flatMap(x=>x.fields.map(field=>({operation:x.operation,tenant:i.tenant,environment:'test',location:x.location,resourceType:x.target.type,resourceId:x.target.id,field,revision:String(command.expectedRevisions.find(r=>key(r.target)===key(x.target)).revision??'absent'),relationships:rel.map(([type,id])=>({type,id})),quantity:e.quantity===null?null:fmt(units(e.quantity)),amount:e.amount===null?null:fmt(units(e.amount)),currency:e.currency,purpose:'customer-evidence',audience:'employee'})));
 return {evidenceRef:i.evidenceRef,executionEffects:map(command.effects),readEffects:map(reads),inspectEffects:map(inspects)};
}
export function createCustomerAdapterM12({tenant,resolveActor,loadOriginal,loadApproval,authorizationOptions,transaction,auditDenied,inspectCommitted}={}){
 if(typeof loadOriginal!=='function'||typeof loadApproval!=='function')fail();
 return createLocalDomainAdapterM10({tenant,resolveActor,authorizationOptions:{...authorizationOptions,deriveScope:deriveCustomerScopeM12},transaction,auditDenied,inspectCommitted,
 resolvePrepared:async({context,request,actor})=>{
  if(!exact(request,['key'])||!id(request.key))fail();
  const original=await loadOriginal({context,key:request.key,actor});
  if(!exact(original,['key','actor','intent'])||original.key!==request.key||!same(original.actor,actor)||original.intent.tenant!==tenant)fail();
  const plan=prepareCustomerM12({intent:original.intent,actor,key:request.key});
  const approval=await loadApproval({context,key:request.key,actor,digest:hash(plan.execution)});
  if(approval?.reference!==original.intent.approvalRef)fail();
  return {...plan,approval};
 },
 verifyExecution:({command,evidence})=>{try{replan(command);return command.payload.intent.snapshots.every(s=>{const found=evidence.find(x=>key(x.target)===key(s.target));return found&&same(found.row,s.row)})}catch{return false}},
 apply:async(tx,c,evidence)=>{
  replan(c);let revision;
  for(const w of c.payload.writes){const prior=evidence.find(x=>key(x.target)===key(w.target)).row;const r=prior===null?await tx.insertDomain({...w.target,record:w.record}):await tx.replaceDomain({...w.target,expectedRevision:prior.revision,record:w.record});if(w.target.type==='sale')revision=r;}
  return {id:c.payload.intent.event.eventId,revision};
 },
 receiptSchema:{version:'customer.evidence.m12',fields:['id','revision']},projectResult:()=>({})
 });
}
