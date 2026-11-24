import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDocumentInvoiceReview,createPurchasingReviewFixture,PURCHASING_FIXTURE_OPERATIONS as O} from '../services/lightspeed/purchasingReviewWorkflow.js';
const at='2026-11-24T15:00:00.000Z', hash='a'.repeat(64);
const channels=['product-manager','scanner','ordering','po-companion','special-orders','direct-api','import','automation'];
function evidence(create=false){
 const source={complete:true,readAt:at};
 const po={id:'P1',reference:'REF',supplier:{id:'S1'},outletId:'O1',poType:'SUPPLIER',purchasingStatus:'OPEN'};
 const x={document:{source:{provider:'graph',accountRef:'mail',messageId:'M1',senderKey:'sender@example.test',observedAt:at},attachment:{id:'A1',mime:'application/pdf',byteLength:100,sha256:hash,scanState:'clean',scanRef:'scan'},extraction:{documentHash:hash,kind:'invoice',parserVersion:'fixture',references:['REF'],lines:[{id:'L1',page:1,documentRef:'page1',supplierSku:'001',quantity:'2',unitCost:'3.00',currency:'USD'}]}},
 priorDocuments:[],documentHistoryComplete:true,aliasRows:[{source:'purchasing:graph:mail',alias:'sender@example.test',supplierId:'S1',verified:true,provenance:'alias',observedAt:at}],aliasCoverage:true,
 header:{invoiceId:'I1',invoiceNumber:'0001',outletId:'O1',supplierId:'S1',reviewRef:'R1',documentHash:hash,poReference:create?null:'REF'},
 targets:[{invoiceLineId:'L1',productId:'PR1',variantId:null,reviewRef:'T1',documentHash:hash,identityEvidenceRef:'identity'}],
 linkRows:[{productId:'PR1',variantId:null,supplierId:'S1',supplierSku:'001',primary:true,source:'catalog',provenance:'link',observedAt:at}],linkCoverage:true,
 poList:{items:create?[]:[po],source,scannedCount:create?0:1,unresolvedReferenceCount:0},poDetail:create?null:{...po,source,lines:[{id:'PL1',productId:'PR1',supplierSku:'001',orderedQty:5}]},
 priorInvoices:[],invoiceHistoryComplete:true,quantityEvidence:{priorLines:[],coverageComplete:true},poVersion:create?null:'P-v1',historyVersion:'H-v1',catalogVersion:'C-v1',expectedRevision:0,recordedAt:at};
 const r=buildDocumentInvoiceReview(x);assert.equal(r.state,'review_required');
 x.approval={invoiceId:'I1',revision:r.revision.revision,fingerprint:r.revision.fingerprint,approvalRef:'A1',recordedAt:'2026-11-24T15:01:00.000Z'};
 return x;
}
function harness(x,denied=new Set(),opts={}){
 const checks=[],events=[];let loads=0;
 const fixture=createPurchasingReviewFixture({authorize:async q=>{checks.push(q);if(opts.outage)throw Error('offline');return opts.truthy?{allowed:true}:!denied.has(q.operation);},audit:async e=>{events.push(e);return !opts.auditFail;},load:async()=>{loads++;return x;},clock:()=>new Date('2026-11-24T15:02:00.000Z')});
 return {checks,events,loads:()=>loads,run:(channel,phase)=>fixture.run({channel,phase,invoiceId:'I1',context:{fixtureActor:'employee'}})};
}
test('document through catalog and PO review binds approval, retains unknown receipt',()=>{
 for(const create of [false,true]){const r=buildDocumentInvoiceReview(evidence(create));assert.equal(r.evidence.proposal.mode,create?'create_open':'update_open');assert.equal(r.evidence.proposal.lines[0].supplierSku,'001');assert.equal(r.receiving.receivedQty,null);assert.equal(r.executable,false);}
});
test('ordinary read exposes wholesale cost without cost-modification grant across every channel',async()=>{
 const f=harness(evidence(),new Set([O.cost,O.approve,O.execute]));
 for(const channel of channels){const r=await f.run(channel,'read');assert.equal(r.state,'read_only');assert.equal(r.lines[0].unitCost,'3.00');}
 assert.ok(f.checks.every(c=>c.operation===O.read));
});
test('denied or unavailable read does not load evidence, truthy decisions and audit failure deny',async()=>{
 for(const f of [harness(evidence(),new Set([O.read])),harness(evidence(),new Set(),{outage:true}),harness(evidence(),new Set(),{truthy:true}),harness(evidence(),new Set(),{auditFail:true})]){
 assert.equal((await f.run('direct-api','read')).reason,'forbidden');assert.equal(f.loads(),0);}
});
test('all channels deny underlying cost modification even with invoice approval and PO grant',async()=>{
 for(const create of [false,true]){const f=harness(evidence(create),new Set([O.cost]));for(const channel of channels){assert.equal((await f.run(channel,'execute')).reason,'forbidden');}
 assert.ok(f.checks.some(c=>c.operation===O.cost&&c.resource.productId==='PR1'&&c.resource.field==='unitCost'));}
});
test('review, approval, execution and exact PO create/update are separate grants',async()=>{
 for(const create of [false,true]){for(const op of [O.review,O.approve,O.execute,create?O.createPO:O.updatePO]){const f=harness(evidence(create),new Set([op]));for(const channel of channels)assert.equal((await f.run(channel,'execute')).reason,'forbidden');}}
});
test('revocation or expiry simulated after approval is rechecked at execution',async()=>{
 const denied=new Set(),f=harness(evidence(),denied);assert.equal((await f.run('ordering','approve')).state,'synthetic_approval_check_passed');denied.add(O.approve);
 assert.equal((await f.run('automation','execute')).reason,'forbidden');assert.ok(f.events.some(e=>e.operation===O.approve&&!e.allowed));
});
test('all grants yield a non-executable check, not a mutation or receipt',async()=>{
 const f=harness(evidence());for(const channel of channels){const r=await f.run(channel,'execute');assert.equal(r.state,'synthetic_execution_check_passed');assert.equal(r.productionExecutable,false);assert.equal(r.executable,false);assert.equal(r.receiving.state,'UNKNOWN');}
});
test('unknown product, variant, ambiguous alias and missing supplier link block instead of creating',()=>{
 for(const mutate of [x=>x.targets[0].productId='UNKNOWN',x=>x.targets[0].variantId='V1',x=>x.linkRows=[],x=>x.aliasRows.push({...x.aliasRows[0],supplierId:'S2'})]){const x=evidence();mutate(x);assert.equal(buildDocumentInvoiceReview(x).state,'needs_review');}
});
test('duplicate documents, prior invoice duplicates, overbilling and stale approval block',async()=>{
 for(const mutate of [x=>x.priorDocuments=[{sourceKey:'b'.repeat(64),documentHash:hash}],x=>x.priorInvoices=[{id:'OTHER',supplierId:'S1',invoiceNumber:'0001',documentHash:'b'.repeat(64)}],x=>x.document.extraction.lines[0].quantity='6']){const x=evidence();mutate(x);assert.equal(buildDocumentInvoiceReview(x).state,'needs_review');}
 const x=evidence();x.approval.fingerprint='c'.repeat(64);assert.equal((await harness(x).run('import','execute')).reason,'approval_stale');
});
test('shipping notice and injected receiving or approval fields cannot produce executable action',()=>{
 const x=evidence();x.document.extraction.kind='shipping_notice';assert.equal(buildDocumentInvoiceReview(x).state,'needs_review');
 const y=evidence();y.document.extraction.receivedQty=5;y.document.extraction.lines[0].ready=true;const r=buildDocumentInvoiceReview(y);assert.equal(r.receiving.receivedQty,null);assert.equal(r.executable,false);assert.equal(Object.hasOwn(r.evidence.proposal.lines[0],'ready'),false);
});
