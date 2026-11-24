import { fingerprintLightspeedPayload } from './idempotency.js';

// Pure domain contract. Persistence, grants, atomic compare-and-swap and audit
// are required from approved backend adapters; this module never performs them.
const exact = x => typeof x==='string' && x.length>0 && x.trim()===x && !/[\x00-\x1f\x7f]/.test(x);
const integer = x => Number.isSafeInteger(x)&&x>0;
const hash = x => typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail = reason => ({state:'needs_review',reason,executable:false});
const instant = x => typeof x==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString()===x;
const unique = (rows,key) => Array.isArray(rows)&&rows.every(r=>r&&exact(r[key]))&&new Set(rows.map(r=>r[key])).size===rows.length;

export function inspectCumulativeInvoiceQuantities({proposal,priorLines,coverageComplete=false}={}){
 if(proposal?.state!=='review_required'||proposal.executable!==false||
   !exact(proposal.invoiceId)||!exact(proposal.supplierId)||!exact(proposal.outletId)||
   !unique(proposal.lines,'invoiceLineId')||!proposal.lines.length||
   coverageComplete!==true||!Array.isArray(priorLines))return fail('invoice_quantity_coverage_missing');
 if(!['create_open','update_open'].includes(proposal.mode))return fail('unknown_mode');
 if(proposal.mode==='create_open'){
   if(proposal.targetPoId!==null||priorLines.length||proposal.lines.some(l=>l.poLineId!==null||!integer(l.invoicedQty)))return fail('new_po_history_conflict');
   return {state:'candidate',totals:proposal.lines.map(l=>({invoiceLineId:l.invoiceLineId,priorInvoicedQty:0,proposedInvoicedQty:l.invoicedQty,cumulativeInvoicedQty:l.invoicedQty,orderedQty:null})),executable:false};
 }
 if(!exact(proposal.targetPoId)||!unique(proposal.lines,'poLineId'))return fail('po_line_identity_unresolved');
 const seen=new Set(), sums=new Map();
 for(const r of priorLines){
   if(!r||!exact(r.invoiceId)||!exact(r.invoiceLineId)||!exact(r.poLineId)||
     r.poId!==proposal.targetPoId||r.supplierId!==proposal.supplierId||r.outletId!==proposal.outletId||
     !integer(r.invoicedQty)||r.invoiceId===proposal.invoiceId||
     r.state!=='verified_current'||!hash(r.documentHash))return fail('prior_invoice_line_unresolved');
   const key=JSON.stringify([r.invoiceId,r.invoiceLineId]);
   if(seen.has(key))return fail('duplicate_prior_invoice_line');
   seen.add(key);
   const total=(sums.get(r.poLineId)||0)+r.invoicedQty;
   if(!Number.isSafeInteger(total))return fail('quantity_overflow');
   sums.set(r.poLineId,total);
 }
 const totals=[];
 for(const l of proposal.lines){
   if(!integer(l.invoicedQty)||!integer(l.orderedQty))return fail('quantity_unresolved');
   const prior=sums.get(l.poLineId)||0,total=prior+l.invoicedQty;
   if(!Number.isSafeInteger(total)||total>l.orderedQty)return fail('cumulative_invoice_exceeds_ordered');
   totals.push({invoiceLineId:l.invoiceLineId,poLineId:l.poLineId,priorInvoicedQty:prior,proposedInvoicedQty:l.invoicedQty,cumulativeInvoicedQty:total,orderedQty:l.orderedQty});
 }
 return {state:'candidate',totals,executable:false};
}

function reviewPayload({proposal,quantityEvidence,poVersion,historyVersion,catalogVersion}={}){
 if(proposal?.state!=='review_required'||proposal.executable!==false||proposal.requiresFullApproval!==true||
   !exact(proposal.invoiceId)||!hash(proposal.documentHash)||!exact(proposal.supplierId)||!exact(proposal.outletId)||
   !unique(proposal.lines,'invoiceLineId')||!proposal.lines.length||
   !exact(historyVersion)||!exact(catalogVersion)||
   !['create_open','update_open'].includes(proposal.mode)||
   (proposal.mode==='update_open'&&(!exact(poVersion)||!exact(proposal.targetPoId)))||
   (proposal.mode==='create_open'&&(poVersion!==null||proposal.targetPoId!==null||proposal.proposedInitialStatus!=='OPEN')))
   throw new TypeError('Invalid review proposal or version evidence.');
 const cumulative=inspectCumulativeInvoiceQuantities({proposal,...quantityEvidence, // explicit proposal wins below
   proposal});
 if(cumulative.state!=='candidate')throw new TypeError(cumulative.reason);
 // Bind full proposal plus relevant evidence versions and cumulative totals.
 // This is a content fingerprint, NOT an approval signature or grant.
 return {proposal,poVersion,historyVersion,catalogVersion,totals:cumulative.totals};
}
export function prepareInvoiceReviewRevision({previous=null,expectedRevision,proposal,quantityEvidence,poVersion,historyVersion,catalogVersion,reviewRef,recordedAt}={}){
 if(!exact(reviewRef)||!instant(recordedAt)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)
   return fail('revision_metadata_invalid');
 if(previous===null?expectedRevision!==0:(!integer(previous.revision)||previous.revision!==expectedRevision||
   previous.invoiceId!==proposal?.invoiceId||previous.supplierId!==proposal?.supplierId||
   previous.outletId!==proposal?.outletId||!hash(previous.fingerprint)||!instant(previous.recordedAt)||
   Date.parse(recordedAt)<=Date.parse(previous.recordedAt)))return fail('revision_conflict');
 if(previous&&['applied','unknown','pending_write'].includes(previous.state))return fail('revision_requires_write_recovery');
 if(expectedRevision===Number.MAX_SAFE_INTEGER)return fail('revision_overflow');
 try{
   const payload=reviewPayload({proposal,quantityEvidence,poVersion,historyVersion,catalogVersion});
   const fingerprint=fingerprintLightspeedPayload(payload);
   // The caller must atomically persist the expected revision and append review audit.
   return {state:'review_required',invoiceId:proposal.invoiceId,supplierId:proposal.supplierId,outletId:proposal.outletId,
     revision:expectedRevision+1,expectedPreviousRevision:expectedRevision,previousFingerprint:previous?.fingerprint??null,
     fingerprint,reviewRef,recordedAt,approval:null,executable:false,requiresAtomicCompareAndSwap:true};
 }catch{return fail('review_payload_unresolved');}
}
export function inspectApprovalBinding({revision,approval,currentEvidence,now,maxAgeMs}={}){
 if(revision?.state!=='review_required'||revision.executable!==false||!integer(revision.revision)||!hash(revision.fingerprint)||
   !instant(revision.recordedAt)||!approval||!exact(approval.approvalRef)||
   approval.invoiceId!==revision.invoiceId||approval.revision!==revision.revision||
   approval.fingerprint!==revision.fingerprint||!instant(approval.recordedAt)||
   !instant(now)||!integer(maxAgeMs))return fail('approval_binding_invalid');
 const age=Date.parse(now)-Date.parse(approval.recordedAt);
 if(age<0||age>maxAgeMs||Date.parse(approval.recordedAt)<Date.parse(revision.recordedAt))return fail('approval_time_invalid');
 try{
   if(fingerprintLightspeedPayload(reviewPayload(currentEvidence))!==revision.fingerprint)return fail('approval_evidence_changed');
 }catch{return fail('approval_evidence_unresolved');}
 // A matching receipt only demonstrates content binding. Security must establish
 // actual authority, and persistence must prove current revision under lock.
 return {state:'binding_matches',invoiceId:revision.invoiceId,revision:revision.revision,
   fingerprint:revision.fingerprint,approvalRef:approval.approvalRef,executable:false,
   requiresVerifiedAuthority:true,requiresAtomicCurrentRevisionCheck:true};
}
