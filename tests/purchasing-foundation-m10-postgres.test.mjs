import test from 'node:test';
import assert from 'node:assert/strict';
import {createInvoicePersistenceM7} from '../services/lightspeed/invoicePersistenceM7.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
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

function distinct(input){
 input.header.invoiceNumber='0002';input.document.source.messageId='M2';
 const hash='b'.repeat(64);input.header.documentHash=hash;input.document.attachment.sha256=hash;input.document.extraction.documentHash=hash;
 for(const t of input.targets)t.documentHash=hash;
}
function fixture(f){
 let now=at,deny=()=>false,reviewer=true,access=()=>true,lost=false;
 const inputs=new Map([['I1',evidence()],['I2',evidence('I2')]]);for(const input of inputs.values())multi(input);distinct(inputs.get('I2'));
 const context={actor:{type:'employee',realm:'employee',tenant:'shop',id:'a',delegation:{kind:'none'}}};
 const read=t=>f.transaction(tx=>tx.lockDomain(t),{targets:[t]});
 const current=(id='I1')=>read({type:'purchasing.invoice',id});
 const ledger=(id='PL1')=>read({type:'purchasing.po.billed-line',id:fp(['S1','O1','P1',id])});
 const history=(id,revision,action)=>read({type:'purchasing.invoice.'+action,id:fp([id,revision])});
 const api=createInvoicePersistenceM7({...f,tenant:'shop',transaction:async(...args)=>{const r=await f.transaction(...args);if(lost)throw Object.assign(Error('lost'),{code:'CORE_COMMIT_UNKNOWN'});return r;},
  resolveActor:c=>c.actor,loadEvidence:id=>structuredClone(inputs.get(id)),readTrustedRow:read,
  issueProof:({execution})=>({reference:'proof-'+fp(execution),executionDigest:fp(execution),reviewerId:'b',expiresAt:Date.parse(now)+120000}),
  verifyReviewer:()=>reviewer,authorizeExecution:q=>!deny(q),authorizeAccess:q=>access(q),clock:()=>new Date(now)});
 const prepare=(action,extra={})=>api.prepare({context,invoiceId:'I1',requestId:'review-1',action,...extra});
 return {inputs,prepare,current,ledger,history,time:v=>now=v,deny:v=>deny=v,reviewer:v=>reviewer=v,access:v=>access=v,lost:v=>lost=v};
}
const pg=(name,fn)=>test(name,()=>withDisposableCorePg(f=>fn(f,fixture(f))));
const denied=p=>assert.rejects(p,{code:'CORE_FORBIDDEN',outcome:'undisclosed'});
pg('P10 competing distinct invoices cannot exceed shared PO-line capacity',async(f,x)=>{
 const a=await x.prepare('review'),b=await x.prepare('review',{invoiceId:'I2',requestId:'review-2'});
 const results=await Promise.allSettled([a.submit(),b.submit()]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'CORE_REVISION_CONFLICT');
 const losing=(await x.current('I1'))?'I2':'I1';
 await assert.rejects(x.prepare('review',{invoiceId:losing,requestId:'retry-2'}),{code:'INVOICE_BILLED_CAPACITY'});
 assert.equal((await x.ledger()).record.reservations.length,1);assert.equal((await x.ledger('PL2')).record.reservations.length,1);
 assert.equal((await f.counts()).commands,1);
});
pg('P10 compatible partial invoices accumulate and approval does not double reserve',async(f,x)=>{
 x.inputs.get('I1').document.extraction.lines[0].quantity='1';x.inputs.get('I1').document.extraction.lines[1].quantity='2';
 x.inputs.get('I2').document.extraction.lines[0].quantity='1';x.inputs.get('I2').document.extraction.lines[1].quantity='2';
 const a=await x.prepare('review');assert.deepEqual(await a.submit(),{replayed:false,result:{}});
 await (await x.prepare('review',{invoiceId:'I2',requestId:'review-2'})).submit();
 const ledger=await x.ledger();assert.deepEqual(ledger.record.reservations.map(r=>r.quantity),[1,1]);
 x.time('2026-11-24T15:01:00.000Z');await (await x.prepare('approve',{requestId:'approve-1'})).submit();
 assert.deepEqual(await x.ledger(),ledger);assert.equal((await f.counts()).outbox,1);
 assert.equal((await x.current()).record.evidence.proposal.executable,false);
});
pg('P10 revision replaces own reservation and preserves immutable multi-line history',async(f,x)=>{
 await (await x.prepare('review')).submit();const before=(await x.history('I1',1,'review')).record;
 x.time('2026-11-24T15:01:00.000Z');await (await x.prepare('approve',{requestId:'approve-1'})).submit();
 const approval=(await x.history('I1',1,'approve')).record;
 x.time('2026-11-24T15:02:00.000Z');x.inputs.get('I1').document.extraction.lines[0].quantity='1';
 await (await x.prepare('review',{requestId:'review-2'})).submit();
 assert.deepEqual((await x.ledger()).record.reservations,[{invoiceId:'I1',revision:2,quantity:1}]);
 assert.equal((await x.current()).record.approval,null);
 assert.deepEqual((await x.history('I1',1,'review')).record,before);
 assert.deepEqual((await x.history('I1',1,'approve')).record,approval);
});
pg('P10 changed PO baseline and stale approved evidence fail closed',async(f,x)=>{
 await (await x.prepare('review')).submit();x.time('2026-11-24T15:01:00.000Z');
 const a=await x.prepare('approve',{requestId:'approve-1'});
 x.inputs.get('I1').poVersion='P1-v2';await denied(a.submit());
 await assert.rejects(x.prepare('review',{requestId:'review-2'}),{code:'INVOICE_BILLED_BASELINE_CHANGED'});
 assert.equal((await x.current()).record.approval,null);assert.equal((await f.counts()).outbox,0);
});
for(const why of ['expiry','reviewer'])pg('P10 final precommit '+why+' denial rolls back approval',async(f,x)=>{
 await (await x.prepare('review')).submit();x.time('2026-11-24T15:01:00.000Z');
 const a=await x.prepare('approve',{requestId:'approve-1'});
 x.deny(q=>{if(q.stage==='beforeCommit'){if(why==='expiry')x.time('2026-11-24T15:04:00.000Z');else x.reviewer(false);}return false;});
 await denied(a.submit());assert.equal((await x.current()).record.approval,null);assert.equal(await x.history('I1',1,'approve'),null);
 assert.equal((await f.counts()).commands,1);assert.equal((await f.counts()).outbox,0);
});
pg('P10 independent read denial retains committed evidence and replay is empty',async(f,x)=>{
 const a=await x.prepare('review');x.access(q=>q.kind!=='read');await denied(a.submit());
 assert.equal((await f.counts()).commands,1);x.access(()=>true);
 assert.deepEqual(await a.submit(),{replayed:true,result:{}});assert.equal((await x.ledger()).record.reservations.length,1);
 x.time('2026-11-24T15:03:00.000Z');await denied(a.submit());assert.equal((await f.counts()).commands,1);
});
pg('P10 unknown local receipt requires separate inspection not remote reconciliation',async(f,x)=>{
 const a=await x.prepare('review');x.lost(true);const seen=[];
 x.access(q=>{seen.push(q.effect.operation);return q.kind!=='inspect'||q.effect.operation==='purchasing.invoice.reconcile-unknown';});
 await denied(a.submit());assert.ok(seen.includes('purchasing.invoice.receipt.inspect'));assert.ok(!seen.includes('purchasing.invoice.reconcile-unknown'));
 x.access(()=>true);assert.deepEqual(await a.submit(),{replayed:true,result:{}});assert.equal((await f.counts()).commands,1);
});
pg('P10 duplicate invoice identity and multi-line rollback preserved',async(f,x)=>{
 const second=x.inputs.get('I2');second.header.invoiceNumber='0001';
 const a=await x.prepare('review'),b=await x.prepare('review',{invoiceId:'I2',requestId:'review-2'});
 x.deny(q=>q.stage==='beforeCommit');await denied(a.submit());assert.equal((await f.typedCounts()).typed_domain,0);
 x.deny(()=>false);await a.submit();await assert.rejects(b.submit(),{code:'CORE_REVISION_CONFLICT'});
 assert.equal((await f.counts()).commands,1);
});
