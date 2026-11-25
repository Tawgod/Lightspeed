// Inventory-owned isolated adapter. No route, vendor writer, or authorization engine.
import {createLocalDomainAdapterM10} from './domainAdapterM10.js';
import {prepareExecutionM7} from './localTransactionM7.js';
import {fingerprintLightspeedPayload as hash} from './idempotency.js';
import {planCountObservation,planRestockConfirmation,planReasonRevision} from './inventoryPersistence.js';
export const VERSION='HC-INVENTORY-EVIDENCE/0.1';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(x)&&x!=='unknown';
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const need=x=>{if(!x)throw TypeError('Inventory evidence admission refused');};
const exact=(x,ks)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===ks.length&&ks.every(k=>Object.hasOwn(x,k));
const dec=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,11})(\.[0-9]{0,5}[1-9])?$/.test(x);
const scaled=x=>{need(dec(x));const [a,b='']=x.split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));};
const decimal=n=>{const a=n/1000000n,b=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return a.toString()+(b?'.'+b:'');};
const target=(type,...parts)=>({type:'inventory.'+type,id:hash(parts)});
const key=t=>hash(t);
export const inventoryTargetM12=target;
const physical={
 receipt:['inventory.receipt.confirm','verified-receipt'],
 fulfillment:['inventory.fulfillment.confirm','verified-handoff'],
 allocation:['inventory.allocation.create','verified-allocation-intent'],
 release:['inventory.allocation.release','allocation'],
 dispatch:['inventory.transfer.dispatch','verified-dispatch'],
 receive:['inventory.transfer.receive','dispatch'],
 returned:['inventory.return.confirm','fulfillment'],
 adjustment:['inventory.adjustment.evidence','verified-discrepancy']
};
const reversal=new Set(['release','receive','returned']);
const identityKeys=['sourceSystem','sourceAccount','sourceId','lineId','productId','variantId','outletId','locationId','destinationOutletId','destinationLocationId','effectiveAt','unit'];
function checkIdentity(p){
 need(identityKeys.every(k=>k==='variantId'?p[k]===null||id(p[k]):k==='effectiveAt'?time(p[k]):id(p[k])));
}
const sameIdentity=(a,b,keys=identityKeys)=>keys.every(k=>a[k]===b[k]);
const sourceTarget=p=>target('source',p.sourceSystem,p.sourceAccount,p.sourceId,p.lineId);
const locationTarget=(o,l)=>target('location',o,l);
const productTarget=p=>target('product',p.productId,p.variantId);
const eventTarget=e=>target('event',e);
const capacityTarget=e=>target('capacity',e);
const stateTarget=(kind,id)=>target(kind,id);
const rel=(type,value)=>({type,id:hash(value)});
// Trusted record snapshots are loaded by the server, never supplied in public request.
// Each snapshot contains exact target, positive storage revision and record.
export function prepareInventoryM12({tenant,actor,intent,records}){
 need(id(tenant)&&actor?.tenant===tenant&&id(actor.id)&&exact(intent,['key','kind','recordedAt','data'])&&id(intent.key)&&time(intent.recordedAt)&&Array.isArray(records));
 const entries=new Map();
 for(const x of records){need(exact(x,['target','revision','record'])&&x.target?.type?.startsWith('inventory.')&&id(x.target.id)&&Number.isSafeInteger(x.revision)&&x.revision>0&&!entries.has(key(x.target)));entries.set(key(x.target),x);}
 const touched=new Map(), effects=[], writes=[], facts=[];
 const touch=(t,outlet,op,relationships,quantity=null,field='evidence')=>{
 need(id(outlet)&&id(op)&&id(field)&&quantity!==undefined);
 const k=key(t),r=entries.get(k)??null;
 if(!touched.has(k))touched.set(k,{target:t,row:r});
 const e={operation:op,target:t,location:outlet,fields:[field]};
 const rich={operation:op,tenant,environment:'test',location:outlet,resourceType:t.type,resourceId:t.id,field,revision:r?String(r.revision):'absent',relationships,quantity,amount:null,currency:null,purpose:'inventory-evidence',audience:null};
 const idx=effects.findIndex(x=>hash(x)===hash(e));
 if(idx<0){effects.push(e);facts.push(rich);}else need(hash(facts[idx])===hash(rich));
 return r;
 };
 const requireRow=(...args)=>{const r=touch(...args);need(r);return r;};
 const insert=(t,record)=>{need(touched.has(key(t))&&!touched.get(key(t)).row&&!writes.some(w=>key(w.target)===key(t)));writes.push({target:t,revision:null,record});};
 const replace=(t,record)=>{const r=touched.get(key(t))?.row;need(r&&!writes.some(w=>key(w.target)===key(t)));writes.push({target:t,revision:r.revision,record});};
 const d=intent.data,k=intent.kind;
 if(Object.hasOwn(physical,k)){
 need(exact(d,['lines'])&&Array.isArray(d.lines)&&d.lines.length>0&&d.lines.length<=100);
 for(const p of d.lines){
 need(exact(p,[...identityKeys,'eventId','originalEventId','quantity'])&&id(p.eventId)&&dec(p.quantity)&&scaled(p.quantity)>0n&&p.effectiveAt<=intent.recordedAt);checkIdentity(p);
 const [op,expected]=physical[k],q=p.quantity;
 const links=[rel('source',[p.sourceSystem,p.sourceAccount,p.sourceId,p.lineId]),rel('product',[p.productId,p.variantId]),rel('endpoints',[p.outletId,p.locationId,p.destinationOutletId,p.destinationLocationId]),rel('event',p.eventId),rel('unit',p.unit),rel('time',p.effectiveAt),rel('original',p.originalEventId)];
 // Distinct per-line field permits exact multiple-line coverage of a shared location/product.
 const field='line-'+hash([p.eventId,p.lineId]);
 const src=sourceTarget(p),s=requireRow(src,p.outletId,op,links,q,field).record;
 need(s.verified===true&&s.kind===(reversal.has(k)?'verified-'+k:expected)&&sameIdentity(s,p)&&dec(s.quantity)&&scaled(q)<=scaled(s.quantity));
 const prod=requireRow(productTarget(p),p.outletId,op,links,q,field).record;
 need(prod.productId===p.productId&&prod.variantId===p.variantId&&prod.verified===true);
 for(const [o,l] of [[p.outletId,p.locationId],[p.destinationOutletId,p.destinationLocationId]]){
 const loc=requireRow(locationTarget(o,l),o,op,links,q,field).record;need(loc.active===true&&loc.outletId===o&&loc.locationId===l);
 }
 if(k==='dispatch'||k==='receive')need(p.outletId!==p.destinationOutletId);
 else need(p.outletId===p.destinationOutletId);
 // One source line may be admitted once globally across all evidence kinds.
 const claim=target('source-use',p.sourceSystem,p.sourceAccount,p.sourceId,p.lineId);
 touch(claim,p.outletId,op,links,q,field);insert(claim,{eventId:p.eventId,kind:k});
 if(reversal.has(k)){
 need(id(p.originalEventId));
 const original=requireRow(eventTarget(p.originalEventId),p.outletId,op,links,q,field).record;
 need(original.kind===expected&&original.eventId===p.originalEventId&&original.stockWrite===false&&original.effectiveAt<=p.effectiveAt&&sameIdentity(original,p,['productId','variantId','outletId','locationId','destinationOutletId','destinationLocationId','unit']));
 const cap=capacityTarget(p.originalEventId),c=requireRow(cap,p.outletId,op,links,q,field).record;
 need(c.originalEventId===p.originalEventId&&c.unit===p.unit&&c.limit===original.quantity&&dec(c.used)&&scaled(c.used)+scaled(q)<=scaled(c.limit));
 replace(cap,{...c,used:decimal(scaled(c.used)+scaled(q))});
 }else need(p.originalEventId===null);
 const ev=eventTarget(p.eventId);touch(ev,p.outletId,op,links,q,field);
 insert(ev,{...p,kind:k,recordedAt:intent.recordedAt,actorId:actor.id,stockWrite:false});
 if(['allocation','dispatch','fulfillment'].includes(k)){
 const cap=capacityTarget(p.eventId);touch(cap,p.outletId,op,links,q,field);insert(cap,{originalEventId:p.eventId,unit:p.unit,limit:q,used:'0'});
 }
 }
 }else{
 const opMap={'count.create':'count.session.create','count.observe':'count.observe','count.close':'count.session.close','count.cancel':'count.session.cancel','restock.create':'restock.task.create','restock.confirm':'restock.confirm','restock.cancel':'restock.task.cancel','reason.revise':'inventory.restock.reason.revise','review.resolve':'count.discrepancy.resolve','count.review':'count.reconcile'};
 const op=opMap[k];need(op&&id(d.id)&&id(d.outletId));
 const links=[rel('workflow',[k,d.id]),rel('outlet',d.outletId),rel('intent',intent.key)];
 const use=(t,operation=op,outlet=d.outletId,field='evidence')=>requireRow(t,outlet,operation,links,null,field).record;
 const make=(t,r,operation=op)=>{touch(t,d.outletId,operation,links);insert(t,r);};
 const session=stateTarget('session',d.id),task=stateTarget('task',d.id);
 if(k==='count.create'){
 need(exact(d,['id','outletId']));make(session,{sessionId:d.id,outletId:d.outletId,state:'open',openedAt:intent.recordedAt});
 }else if(k==='count.observe'){
 need(exact(d,['id','outletId','request']));const s=use(session);need(s.outletId===d.outletId);
 const r=d.request,prod=use(productTarget(r));need(prod.verified===true&&prod.productId===r.productId&&prod.variantId===r.variantId);
 if(r.locationId!=null){const loc=use(locationTarget(d.outletId,r.locationId));need(loc.active===true&&loc.outletId===d.outletId&&loc.locationId===r.locationId);}
 const plan=planCountObservation({session:s,request:r,actorId:actor.id,recordedAt:intent.recordedAt});need(plan.status==='planned');
 make(target('scan',d.id,r.scanId),plan.records.observation);
 }else if(k==='count.close'||k==='count.cancel'){
 need(exact(d,['id','outletId']));const s=use(session);need(s.state==='open'&&s.outletId===d.outletId&&intent.recordedAt>=s.openedAt);replace(session,{...s,state:k==='count.close'?'closed':'cancelled',endedAt:intent.recordedAt});
 }else if(k==='count.review'){
 need(exact(d,['id','outletId','scanId','reviewId','reasonCode']));const s=use(session);need(s.state==='closed'&&s.outletId===d.outletId);
 const scan=use(target('scan',d.id,d.scanId));need(scan.sessionId===d.id&&scan.outletId===d.outletId);
 const reason=use(target('reason',d.reasonCode));need(reason.active===true&&reason.code===d.reasonCode);
 make(target('review',d.reviewId),{reviewId:d.reviewId,sessionId:d.id,scanId:d.scanId,outletId:d.outletId,state:'open',reason,quantityVariance:null,stockWrite:false});
 }else if(k==='reason.revise'){
 need(exact(d,['id','outletId','next'])&&d.next.code===d.id);const t=target('reason',d.id),r=touch(t,d.outletId,op,links);
 const p=planReasonRevision({current:r?.record,next:d.next,actorId:actor.id,recordedAt:intent.recordedAt});need(p.status==='planned');
 make(target('reason-revision',d.id,d.next.revision),p.records.reason);
 if(r)replace(t,p.records.reason);else insert(t,p.records.reason);
 }else if(k==='restock.create'){
 need(exact(d,['id','outletId','lines'])&&Array.isArray(d.lines)&&d.lines.length>0&&d.lines.length<=500);
 const seen=new Set();
 for(const l of d.lines){need(exact(l,['lineId','outletId','productId','variantId','fromLocationId','toLocationId','plannedQuantity'])&&id(l.lineId)&&!seen.has(l.lineId)&&l.outletId===d.outletId&&Number.isSafeInteger(l.plannedQuantity)&&l.plannedQuantity>0);seen.add(l.lineId);
 const p=use(productTarget(l));need(p.verified===true&&p.productId===l.productId&&p.variantId===l.variantId);
 for(const [loc,kind] of [[l.fromLocationId,'storage'],[l.toLocationId,'floor']]){const a=use(locationTarget(d.outletId,loc));need(a.active&&a.outletId===d.outletId&&a.locationId===loc&&a.kind===kind);}
 }
 make(task,{taskId:d.id,outletId:d.outletId,state:'open',version:'v1',lines:d.lines});
 }else if(k==='restock.confirm'){
 need(exact(d,['id','outletId','request']));const t=use(task);need(t.outletId===d.outletId);
 const locations=new Map(),reasons=new Map();
 for(const l of t.lines){const p=use(productTarget(l));need(p.verified===true&&p.productId===l.productId&&p.variantId===l.variantId);for(const loc of [l.fromLocationId,l.toLocationId])locations.set(loc,use(locationTarget(d.outletId,loc)));}
 for(const l of d.request.lines)if(l.reasonCode!=null)reasons.set(l.reasonCode,use(target('reason',l.reasonCode)));
 const plan=planRestockConfirmation({task:t,request:d.request,locations:[...locations.values()],reasons:[...reasons.values()],actorId:actor.id,recordedAt:intent.recordedAt});need(plan.status==='planned');
 make(target('batch',d.request.batchId),plan.records.confirmation);
 for(const r of plan.records.reviews)make(target('review',r.reviewId),r,'inventory.discrepancy.record');
 replace(task,{...t,state:'closed',version:'v2'});
 }else if(k==='restock.cancel'){
 need(exact(d,['id','outletId']));const t=use(task);need(t.state==='open'&&t.outletId===d.outletId);replace(task,{...t,state:'cancelled',version:'v2'});
 }else if(k==='review.resolve'){
 need(exact(d,['id','outletId','resolution'])&&id(d.resolution));const t=target('review',d.id),r=use(t);need(r.state==='open'&&r.outletId===d.outletId);replace(t,{...r,state:'resolved',resolution:d.resolution,resolvedAt:intent.recordedAt,stockWrite:false});
 }
 }
 need(writes.length>0&&effects.length>0);
 // No unused snapshots can enter the command. The original immutable snapshot is
 // deliberately retained for replay; current locks must match before first execution.
 const locked=[...touched.values()].map(x=>({target:x.target,revision:x.row?.revision??null,record:x.row?.record??null}));
 const execution=prepareExecutionM7({tenant,scope:'test.inventory.m12',key:intent.key,actor,targets:locked.map(x=>x.target),effects,payload:{intent,records:locked.filter(x=>x.revision!==null)},expectedRevisions:locked.map(x=>({target:x.target,revision:x.revision}))});
 const primary=effects[0],primaryRich=facts[0];
 const readEffects=[{...primary,operation:'inventory.evidence.read',fields:['outcome']}],reconcileEffects=[{...primary,operation:'transactions.reconcile',fields:['receipt']}];
 const access=(e)=>({...primaryRich,operation:e.operation,field:e.fields[0]});
 return {execution,readEffects,reconcileEffects,facts:{executionEffects:facts,readEffects:readEffects.map(access),inspectEffects:reconcileEffects.map(access)},locked,writes};
}
export function createInventoryAdapterM12({tenant,resolveActor,loadOriginal,loadApproval,resolveEvidenceRef,authorizationOptions,transaction,auditDenied,inspectCommitted}={}){
 need([resolveActor,loadOriginal,loadApproval,resolveEvidenceRef].every(f=>typeof f==='function'));
 const plan=c=>prepareInventoryM12({tenant,actor:c.actor,intent:c.payload.intent,records:c.payload.records});
 return createLocalDomainAdapterM10({tenant,resolveActor,transaction,auditDenied,inspectCommitted,
 resolvePrepared:async({context,request,actor})=>{
 need(exact(request,['key'])&&id(request.key));
 const original=await loadOriginal({context,key:request.key,actor});need(original?.intent?.key===request.key&&original.actorId===actor.id&&original.tenant===tenant);
 const p=prepareInventoryM12({tenant,actor,intent:original.intent,records:original.records});
 const approval=await loadApproval({context,actor,key:request.key,digest:hash(p.execution)});
 need(approval?.reference===original.approvalRef);
 return {execution:p.execution,approval,readEffects:p.readEffects,reconcileEffects:p.reconcileEffects};
 },
 authorizationOptions:{...authorizationOptions,deriveScope:async({command})=>({...plan(command).facts,evidenceRef:await resolveEvidenceRef(command.actor)})},
 verifyExecution:({command,evidence})=>{
 try{const p=plan(command);return hash(p.execution)===hash(command)&&p.locked.every(x=>{const r=evidence.find(y=>key(y.target)===key(x.target))?.row;return (r?.revision??null)===x.revision&&hash(r?.record??null)===hash(x.record);});}catch{return false;}
 },
 apply:async(tx,command)=>{const p=plan(command);for(const w of p.writes){if(w.revision===null)await tx.insertDomain({...w.target,record:w.record});else await tx.replaceDomain({...w.target,expectedRevision:w.revision,record:w.record});}return {id:command.key,outcome:'evidence-recorded'};},
 receiptSchema:{version:'inventory.m12.receipt',fields:['id','outcome']},projectResult:()=>({})
 });
}
