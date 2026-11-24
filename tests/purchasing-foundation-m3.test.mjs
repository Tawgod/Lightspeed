import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCumulativeInvoiceQuantities,prepareInvoiceReviewRevision,inspectApprovalBinding} from '../services/lightspeed/invoiceReviewContract.js';
const proposal={state:'review_required',executable:false,requiresFullApproval:true,mode:'update_open',invoiceId:'I2',supplierId:'S1',outletId:'O1',targetPoId:'P1',documentHash:'a'.repeat(64),lines:[{invoiceLineId:'L2',poLineId:'PL1',orderedQty:10,invoicedQty:4,unitCost:'2.00'}]};
const prior={invoiceId:'I1',invoiceLineId:'L1',poId:'P1',poLineId:'PL1',supplierId:'S1',outletId:'O1',invoicedQty:6,state:'verified_current',documentHash:'b'.repeat(64)};
const evidence={proposal,quantityEvidence:{priorLines:[prior],coverageComplete:true},poVersion:'P-v1',historyVersion:'H-v1',catalogVersion:'C-v1'};
const time='2026-11-24T15:00:00.000Z';
const args={...evidence,expectedRevision:0,reviewRef:'R1',recordedAt:time};
const revision=()=>prepareInvoiceReviewRevision(args);
const approval=r=>({invoiceId:r.invoiceId,revision:r.revision,fingerprint:r.fingerprint,approvalRef:'A1',recordedAt:'2026-11-24T15:01:00.000Z'});
const bind=(r,a=approval(r),currentEvidence=evidence)=>inspectApprovalBinding({revision:r,approval:a,currentEvidence,now:'2026-11-24T15:02:00.000Z',maxAgeMs:120000});
test('partial invoices sum without modifying ordered quantity or creating receipt',()=>{
 const r=inspectCumulativeInvoiceQuantities({proposal,priorLines:[prior],coverageComplete:true});
 assert.deepEqual(r.totals,[{invoiceLineId:'L2',poLineId:'PL1',priorInvoicedQty:6,proposedInvoicedQty:4,cumulativeInvoicedQty:10,orderedQty:10}]);assert.equal(r.executable,false);
});
test('cumulative overbilling and incomplete coverage block',()=>{
 assert.equal(inspectCumulativeInvoiceQuantities({proposal,priorLines:[{...prior,invoicedQty:7}],coverageComplete:true}).reason,'cumulative_invoice_exceeds_ordered');
 assert.equal(inspectCumulativeInvoiceQuantities({proposal,priorLines:[],coverageComplete:false}).state,'needs_review');
});
test('duplicate prior line, wrong scope, current invoice and unverified revision block',()=>{
 for(const priorLines of [[prior,prior],[{...prior,outletId:'O2'}],[{...prior,invoiceId:'I2'}],[{...prior,state:'superseded'}]])assert.equal(inspectCumulativeInvoiceQuantities({proposal,priorLines,coverageComplete:true}).state,'needs_review');
});
test('new OPEN candidate has no historical PO lines',()=>{
 const p={...proposal,mode:'create_open',targetPoId:null,proposedInitialStatus:'OPEN',lines:[{...proposal.lines[0],poLineId:null,orderedQty:null}]};
 assert.equal(inspectCumulativeInvoiceQuantities({proposal:p,priorLines:[],coverageComplete:true}).state,'candidate');
 assert.equal(inspectCumulativeInvoiceQuantities({proposal:p,priorLines:[prior],coverageComplete:true}).state,'needs_review');
});
test('revision is content-bound and requires atomic persistence, not execution',()=>{
 const r=revision();assert.equal(r.revision,1);assert.equal(r.expectedPreviousRevision,0);assert.equal(r.approval,null);assert.equal(r.requiresAtomicCompareAndSwap,true);assert.equal(r.executable,false);assert.match(r.fingerprint,/^[a-f0-9]{64}$/);
});
test('concurrent stale revision rejected against current snapshot',()=>{
 const r=revision();assert.equal(prepareInvoiceReviewRevision({...args,previous:r,recordedAt:'2026-11-24T15:01:00.000Z'}).reason,'revision_conflict');
 const next=prepareInvoiceReviewRevision({...args,previous:r,expectedRevision:1,recordedAt:'2026-11-24T15:01:00.000Z'});
 assert.equal(next.revision,2);assert.equal(next.approval,null);assert.equal(next.previousFingerprint,r.fingerprint);
 assert.equal(bind(next,approval(r)).state,'needs_review');
});
test('unknown or pending write state requires recovery rather than replacement',()=>{
 for(const state of ['unknown','pending_write','applied','unexpected'])assert.equal(prepareInvoiceReviewRevision({...args,previous:{...revision(),state},expectedRevision:1,recordedAt:'2026-11-24T15:01:00.000Z'}).reason,'revision_requires_write_recovery');
});
test('matching approval receipt is not authority or executable',()=>{
 const r=revision(),b=bind(r);assert.equal(b.state,'binding_matches');assert.equal(b.executable,false);assert.equal(b.requiresVerifiedAuthority,true);assert.equal(b.requiresAtomicCurrentRevisionCheck,true);
});
test('changed proposal, PO, history or catalog versions invalidate receipt',()=>{
 const r=revision();
 for(const e of [{...evidence,poVersion:'P-v2'},{...evidence,historyVersion:'H-v2'},{...evidence,catalogVersion:'C-v2'},{...evidence,proposal:{...proposal,lines:[{...proposal.lines[0],unitCost:'3.00'}]}},{...evidence,quantityEvidence:{priorLines:[{...prior,documentHash:'c'.repeat(64)}],coverageComplete:true}}])assert.equal(bind(r,approval(r),e).reason,'approval_evidence_changed');
});
test('expired, future and pre-revision approvals fail',()=>{
 const r=revision();
 for(const recordedAt of ['2026-11-24T14:59:00.000Z','2026-11-24T15:03:00.000Z'])assert.equal(bind(r,{...approval(r),recordedAt}).state,'needs_review');
 assert.equal(inspectApprovalBinding({revision:r,approval:approval(r),currentEvidence:evidence,now:'2026-11-24T16:00:00.000Z',maxAgeMs:120000}).reason,'approval_time_invalid');
});
