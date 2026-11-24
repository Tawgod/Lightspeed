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
 const api=createInvoicePersistenceM6({...f,tenant,transaction,strictP09:true,authorize:q=>!deny(q),authorizeRead:()=>!denyRead,
  authorizeReconcile:q=>typeof denyReconcile==='function'?!denyReconcile(q):!denyReconcile,verifyReviewer:()=>reviewer,resolveActor:c=>c.actor,
  loadEvidence:id=>structuredClone(inputs.get(id)),clock:()=>new Date(now)});
 const read=async(type,id)=>{const t={type,id};return f.transaction(tx=>tx.lockDomain(t),{targets:[t]});};
 const current=(id='I1')=>read('purchasing.invoice',id);
 const history=(id,revision,action)=>read('purchasing.invoice.'+action,fp([id,revision]));
 const prepare=(action,extra={})=>api.prepare({context,invoiceId:'I1',requestId:'review-1',action,...extra});
 const approve=async(extra={})=>prepare('approve',{currentRow:await current(),requestId:'approve-1',...extra});
 return {inputs,context,prepare,approve,current,history,deny:v=>deny=v,denyRead:v=>denyRead=v,denyReconcile:v=>denyReconcile=v,
  reviewer:v=>reviewer=v,lost:v=>lost=v,time:v=>now=v};
}

function changeHash(input,hash){
 input.header.documentHash=hash;input.document.attachment.sha256=hash;input.document.extraction.documentHash=hash;
 for(const t of input.targets)t.documentHash=hash;
}
for(const collision of ['source','hash','number'])pg('P09 competing invoice '+collision+' identity race',async(f,x)=>{
 const second=x.inputs.get('I2');
 if(collision!=='source')second.document.source.messageId='M2';
 if(collision!=='hash')changeHash(second,'b'.repeat(64));
 if(collision!=='number')second.header.invoiceNumber='0002';
 // Exactly one identity is shared across two differently keyed invoice commands.
 const a=await x.prepare('review'),b=await x.prepare('review',{invoiceId:'I2',requestId:'review-2'});
 const results=await Promise.allSettled([a.submit(),b.submit()]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'CORE_REVISION_CONFLICT');
 assert.equal((await f.counts()).commands,1);assert.equal((await f.typedCounts()).typed_domain,5);
 const rows=await Promise.all([x.current('I1'),x.current('I2')]);
 assert.equal(rows.filter(Boolean).length,1);
});
function multi(input){
 const line=input.document.extraction.lines[0];
 input.document.extraction.lines.push({...line,id:'L2',supplierSku:'002',quantity:'3',unitCost:'4.00'});
 input.targets.push({...input.targets[0],invoiceLineId:'L2',productId:'PR2',reviewRef:'T2'});
 input.linkRows.push({...input.linkRows[0],productId:'PR2',supplierSku:'002'});
 const po={id:'P1',reference:'00042',supplier:{id:'S1'},outletId:'O1',poType:'SUPPLIER',purchasingStatus:'OPEN'};
 input.header.poReference='00042';input.document.extraction.references=['00042'];
 input.poList={...input.poList,items:[po],scannedCount:1};
 input.poDetail={...po,source:input.poList.source,lines:[{id:'PL1',productId:'PR1',supplierSku:'001',orderedQty:5},{id:'PL2',productId:'PR2',supplierSku:'002',orderedQty:8}]};
 input.poVersion='P1-v1';
 input.quantityEvidence.priorLines=[{invoiceId:'OLD',invoiceLineId:'OLD1',poId:'P1',poLineId:'PL1',supplierId:'S1',outletId:'O1',invoicedQty:3,state:'verified_current',documentHash:'c'.repeat(64)},{invoiceId:'OLD',invoiceLineId:'OLD2',poId:'P1',poLineId:'PL2',supplierId:'S1',outletId:'O1',invoicedQty:4,state:'verified_current',documentHash:'c'.repeat(64)}];
}
pg('P09 multi-line reviewed PO association and cumulative billed evidence remain separate from receipt',async(f,x)=>{
 const input=x.inputs.get('I1');multi(input);
 await (await x.prepare('review')).submit();const row=(await x.current()).record;
 assert.equal(row.evidence.proposal.targetPoId,'P1');assert.equal(row.evidence.proposal.mode,'update_open');
 assert.deepEqual(row.evidence.proposal.lines.map(l=>[l.poLineId,l.invoicedQty,l.orderedQty]),[['PL1',2,5],['PL2',3,8]]);
 assert.equal(row.evidence.proposal.executable,false);
 assert.ok(row.evidence.proposal.lines.every(l=>!Object.hasOwn(l,'receivedQty')));
 x.time('2026-11-24T15:01:00.000Z');const a=await x.approve();await a.submit();
 assert.equal((await f.counts()).outbox,1);assert.equal((await x.current()).record.approval.revision,1);
});
pg('P09 cumulative overbilling or ambiguous PO blocks multi-line preparation',async(f,x)=>{
 const input=x.inputs.get('I1');multi(input);
 input.quantityEvidence.priorLines[1].invoicedQty=6;
 await assert.rejects(x.prepare('review'),{code:'INVOICE_EVIDENCE_UNRESOLVED'});
 input.quantityEvidence.priorLines[1].invoicedQty=4;
 input.poList.items.push({...input.poList.items[0],id:'P2'});input.poList.scannedCount=2;
 await assert.rejects(x.prepare('review'),{code:'INVOICE_EVIDENCE_UNRESOLVED'});
 assert.equal((await f.counts()).commands,0);
});
for(const reason of ['expiry','reviewer'])pg('P09 final precommit '+reason+' denial rolls back approval, receipt and outbox',async(f,x)=>{
 await (await x.prepare('review')).submit();x.time('2026-11-24T15:01:00.000Z');
 const a=await x.approve();
 x.deny(q=>{if(q.stage==='beforeCommit'){if(reason==='expiry')x.time('2026-11-24T15:04:00.000Z');else x.reviewer(false);}return false;});
 await assert.rejects(a.submit(),{code:'CORE_FORBIDDEN',outcome:'not_committed'});
 assert.equal((await x.current()).record.approval,null);
 assert.equal(await x.history('I1',1,'approve'),null);
 assert.equal((await f.counts()).commands,1);assert.equal((await f.counts()).outbox,0);
});
pg('P09 expired historical approval does not disclose or repeat; ledger retained',async(f,x)=>{
 await (await x.prepare('review')).submit();x.time('2026-11-24T15:01:00.000Z');const a=await x.approve();await a.submit();
 const old=(await x.history('I1',1,'approve')).record;
 x.time('2026-11-24T15:04:00.000Z');await assert.rejects(a.submit(),{code:'CORE_FORBIDDEN',outcome:'committed'});
 assert.deepEqual((await x.history('I1',1,'approve')).record,old);assert.equal((await f.counts()).outbox,1);
});
pg('P09 local receipt reconciliation does not use remote PO grant',async(f,x)=>{
 const a=await x.prepare('review');x.lost(true);
 const seen=[];x.denyReconcile(q=>{seen.push(q.effect.operation);return q.effect.operation!=='purchasing.invoice.reconcile-unknown';});
 await assert.rejects(a.submit(),{code:'CORE_FORBIDDEN',outcome:'unknown'});
 assert.ok(!seen.includes('purchasing.invoice.reconcile-unknown'));
 x.denyReconcile(q=>!['purchasing.invoice.receipt.inspect','purchasing.audit.read'].includes(q.effect.operation));
 assert.equal((await a.submit()).replayed,true);assert.equal((await f.counts()).commands,1);
});
