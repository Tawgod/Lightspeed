import test from 'node:test';
import assert from 'node:assert/strict';
import {createInvoicePersistenceM6,isCurrentInvoiceReviewIntent} from '../services/lightspeed/invoicePersistenceM6.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
import {PURCHASING_FIXTURE_OPERATIONS as O} from '../services/lightspeed/purchasingReviewWorkflow.js';
import {fingerprintLightspeedPayload as fp} from '../services/lightspeed/idempotency.js';
const at='2026-11-24T15:00:00.000Z', hash='a'.repeat(64);
function evidence(id='I1'){
 const source={complete:true,readAt:at};
 return {document:{source:{provider:'graph',accountRef:'mail',messageId:'M1',senderKey:'sender@example.test',observedAt:at},attachment:{id:'A1',mime:'application/pdf',byteLength:100,sha256:hash,scanState:'clean',scanRef:'scan'},extraction:{documentHash:hash,kind:'invoice',parserVersion:'fixture',references:[],lines:[{id:'L1',page:1,documentRef:'page1',supplierSku:'001',quantity:'2',unitCost:'3.00',currency:'USD'}]}},
 priorDocuments:[],documentHistoryComplete:true,aliasRows:[{source:'purchasing:graph:mail',alias:'sender@example.test',supplierId:'S1',verified:true,provenance:'alias',observedAt:at}],aliasCoverage:true,
 header:{invoiceId:id,invoiceNumber:'0001',outletId:'O1',supplierId:'S1',reviewRef:'R1',documentHash:hash,poReference:null},
 targets:[{invoiceLineId:'L1',productId:'PR1',variantId:null,reviewRef:'T1',documentHash:hash,identityEvidenceRef:'identity'}],
 linkRows:[{productId:'PR1',variantId:null,supplierId:'S1',supplierSku:'001',primary:true,source:'catalog',provenance:'link',observedAt:at}],linkCoverage:true,
 poList:{items:[],source,scannedCount:0,unresolvedReferenceCount:0},poDetail:null,priorInvoices:[],invoiceHistoryComplete:true,quantityEvidence:{priorLines:[],coverageComplete:true},poVersion:null,historyVersion:'H1',catalogVersion:'C1'};
}

const pg=(name,fn)=>test(name,()=>withDisposableCorePg(f=>fn(f,fixture(f))));
function fixture(f,tenant='shop'){
 let now=at,deny=()=>false,denyRead=false,denyReconcile=false,reviewer=true,lost=false;
 const inputs=new Map([['I1',evidence()],['I2',evidence('I2')]]);
 const actor={type:'employee',realm:'employee',tenant,id:'reviewer-1',delegation:{kind:'none'}};
 const context={actor};
 const transaction=async(...args)=>{const r=await f.transaction(...args);if(lost)throw Object.assign(Error('lost ack'),{code:'CORE_COMMIT_UNKNOWN'});return r;};
 const api=createInvoicePersistenceM6({...f,tenant,transaction,authorize:q=>!deny(q),authorizeRead:()=>!denyRead,
  authorizeReconcile:()=>!denyReconcile,verifyReviewer:()=>reviewer,resolveActor:c=>c.actor,
  loadEvidence:id=>structuredClone(inputs.get(id)),clock:()=>new Date(now)});
 const read=async(type,id)=>{const t={type,id};return f.transaction(tx=>tx.lockDomain(t),{targets:[t]});};
 const current=(id='I1')=>read('purchasing.invoice',id);
 const history=(id,revision,action)=>read('purchasing.invoice.'+action,fp([id,revision]));
 const prepare=(action,extra={})=>api.prepare({context,invoiceId:'I1',requestId:'review-1',action,...extra});
 const approve=async(extra={})=>prepare('approve',{currentRow:await current(),requestId:'approve-1',...extra});
 return {inputs,context,prepare,approve,current,history,deny:v=>deny=v,denyRead:v=>denyRead=v,denyReconcile:v=>denyReconcile=v,
  reviewer:v=>reviewer=v,lost:v=>lost=v,time:v=>now=v};
}
pg('P08 concurrent same command replays; duplicate identity across invoices rejects',async(f,x)=>{
 const a=await x.prepare('review'),b=await x.prepare('review',{invoiceId:'I2',requestId:'review-2'});
 const results=await Promise.all([a.submit(),a.submit()]);
 assert.equal(results.filter(r=>r.replayed).length,1);
 assert.deepEqual(results[0].result,{invoiceId:'I1',revision:1,state:'review_recorded',executable:false});
 await assert.rejects(b.submit(),{code:'CORE_REVISION_CONFLICT'});
 assert.equal((await f.counts()).commands,1);
 assert.equal((await f.typedCounts()).typed_domain,5);
});
pg('P08 immutable review and approval history; later revision invalidates old intent',async(f,x)=>{
 await (await x.prepare('review')).submit();
 const first=(await x.current()).record;
 x.time('2026-11-24T15:01:00.000Z');
 const a=await x.approve();
 const results=await Promise.all([a.submit(),a.submit()]);assert.equal(results.filter(r=>r.replayed).length,1);
 const approved=(await x.current()).record;
 const intent={kind:'invoice-review-approved',invoiceId:'I1',revision:1,fingerprint:approved.revision.fingerprint,approvalRef:approved.approval.approvalRef,executable:false};
 assert.equal(isCurrentInvoiceReviewIntent({intent,current:approved}),true);
 assert.deepEqual((await x.history('I1',1,'review')).record,first);
 assert.deepEqual((await x.history('I1',1,'approve')).record.approval,approved.approval);
 x.time('2026-11-24T15:02:00.000Z');
 await (await x.prepare('review',{currentRow:await x.current(),requestId:'review-2'})).submit();
 const newer=(await x.current()).record;
 assert.equal(newer.revision.revision,2);assert.equal(newer.approval,null);
 assert.equal(isCurrentInvoiceReviewIntent({intent,current:newer}),false);
 assert.deepEqual((await x.history('I1',1,'review')).record,first);
 assert.deepEqual((await x.history('I1',1,'approve')).record.approval,approved.approval);
 assert.equal((await a.submit()).result.state,'approval_recorded'); // historical, not current
 assert.equal((await f.counts()).outbox,1);
});
pg('P08 scoped denial after lock and precommit rolls back all local effects',async(f,x)=>{
 const a=await x.prepare('review');
 x.deny(q=>q.stage==='afterLocks'&&q.effect.operation===O.review&&q.effect.location==='O1');
 await assert.rejects(a.submit(),{code:'CORE_FORBIDDEN',outcome:'not_committed'});
 x.deny(q=>q.stage==='beforeCommit'&&q.effect.operation===O.review);
 await assert.rejects(a.submit(),{code:'CORE_FORBIDDEN',outcome:'not_committed'});
 assert.deepEqual(await f.counts(),{commands:0,domain:0,outbox:0,audit:2});
 assert.equal((await f.typedCounts()).typed_domain,0);
 x.deny(()=>false);await a.submit();
 x.time('2026-11-24T15:01:00.000Z');const b=await x.approve();
 x.deny(q=>q.stage==='beforeCommit'&&q.effect.operation===O.approve);
 await assert.rejects(b.submit(),{code:'CORE_FORBIDDEN',outcome:'not_committed'});
 assert.equal((await x.current()).record.approval,null);assert.equal((await f.counts()).outbox,0);
 x.deny(()=>false);await b.submit();assert.equal((await f.counts()).outbox,1);
});
pg('P08 replay read denial is committed; actor change conflicts and never reapplies',async(f,x)=>{
 const a=await x.prepare('review');await a.submit();
 x.denyRead(true);await assert.rejects(a.submit(),{code:'CORE_FORBIDDEN',outcome:'committed'});
 x.denyRead(false);
 const b=await x.prepare('review',{context:{actor:{...x.context.actor,id:'reviewer-2'}}});
 await assert.rejects(b.submit(),{code:'CORE_KEY_CONFLICT'});
 assert.equal((await f.counts()).commands,1);
});
pg('P08 changed locked evidence or reviewer revocation refuses approval',async(f,x)=>{
 await (await x.prepare('review')).submit();
 x.time('2026-11-24T15:01:00.000Z');const a=await x.approve();
 x.inputs.get('I1').catalogVersion='changed';
 await assert.rejects(a.submit(),{code:'CORE_EFFECT_CHANGED'});
 x.inputs.get('I1').catalogVersion='C1';
 x.reviewer(false);await assert.rejects(a.submit(),{code:'CORE_FORBIDDEN'});
 x.reviewer(true);x.time('2026-11-24T15:05:00.000Z');
 await assert.rejects(a.submit(),{code:'CORE_EFFECT_CHANGED'});
 assert.equal((await x.current()).record.approval,null);assert.equal((await f.counts()).outbox,0);
});
pg('P08 lost acknowledgement resolves once; independent reconciliation denied',async(f,x)=>{
 const a=await x.prepare('review');x.lost(true);x.denyReconcile(true);
 await assert.rejects(a.submit(),{code:'CORE_FORBIDDEN',outcome:'unknown'});
 x.denyReconcile(false);assert.equal((await a.submit()).replayed,true);
 assert.equal((await f.counts()).commands,1);assert.equal((await f.typedCounts()).typed_domain,5);
});
pg('P08 tenant and unsupported delegation fail closed; separate tenant fixture may use same identifiers',async(f,x)=>{
 await assert.rejects(x.prepare('review',{context:{actor:{...x.context.actor,tenant:'other'}}}),{code:'CORE_FORBIDDEN'});
 await assert.rejects(x.prepare('review',{context:{actor:{...x.context.actor,delegation:{kind:'delegated'}}}}),{code:'CORE_FORBIDDEN'});
 await (await x.prepare('review')).submit();
 await withDisposableCorePg(async g=>{const y=fixture(g,'other');await (await y.prepare('review')).submit();assert.equal((await g.counts()).commands,1);});
 assert.equal((await f.counts()).commands,1);
});
pg('P08 stale pointer and changed source identity cannot overwrite history',async(f,x)=>{
 await (await x.prepare('review')).submit();const old=await x.current();
 x.time('2026-11-24T15:01:00.000Z');
 const a=await x.prepare('review',{currentRow:old,requestId:'review-2'});
 const b=await x.prepare('review',{currentRow:old,requestId:'review-3'});
 await a.submit();await assert.rejects(b.submit(),{code:'CORE_REVISION_CONFLICT'});
 x.time('2026-11-24T15:02:00.000Z');x.inputs.get('I1').document.source.messageId='M2';
 await assert.rejects(x.prepare('review',{currentRow:await x.current(),requestId:'review-4'}),{code:'INVOICE_IDENTITY_CHANGED'});
 assert.equal((await x.current()).record.revision.revision,2);
});
