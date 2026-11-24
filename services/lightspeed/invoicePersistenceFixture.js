import {createLocalTransactionCandidate} from './localTransactionCandidate.js';
import {fingerprintLightspeedPayload} from './idempotency.js';
import {buildDocumentInvoiceReview,PURCHASING_FIXTURE_OPERATIONS as O} from './purchasingReviewWorkflow.js';
import {inspectApprovalBinding} from './invoiceReviewContract.js';

// Test-only domain composition. Core owns transactions and Security owns actor/grant decisions.
const exact=x=>typeof x==='string'&&x.length>0&&x.length<=256&&x.trim()===x&&!/[\x00-\x1f\x7f]/.test(x);
const fail=code=>Object.assign(new Error('Invoice fixture refused.'),{code});
const copy=x=>{fingerprintLightspeedPayload(x);return JSON.parse(JSON.stringify(x));};
const key=x=>fingerprintLightspeedPayload(x);
export function createInvoicePersistenceFixture({transaction,authorize,auditDenied,resolveActor,clock=()=>new Date(),maxAgeMs=120000}={}){
 if(typeof resolveActor!=='function')throw new TypeError('Synthetic actor resolver required');
 const run=createLocalTransactionCandidate({transaction,authorize,auditDenied});
 return Object.freeze({async submit({context,invoiceId,action,expectedRevision,expectedFingerprint,requestId}={}){
  if(!exact(invoiceId)||!exact(requestId)||!['review','approve'].includes(action)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||
   !(expectedFingerprint===null||typeof expectedFingerprint==='string'&&/^[a-f0-9]{64}$/.test(expectedFingerprint)))throw fail('INVOICE_REQUEST_INVALID');
  if(action==='approve'&&(expectedRevision===0||expectedFingerprint===null))throw fail('INVOICE_REQUEST_INVALID');
  const actor=await resolveActor(context);
  if(!exact(actor))throw fail('CORE_FORBIDDEN');
  // Canonical key independent of tool; actor in fingerprint prevents cross-actor replay.
  const payload={actor,invoiceId,action,expectedRevision,expectedFingerprint};
  const resource={invoiceId};
  return run({scope:'test:purchasing:invoice.'+action,key:'invoice-'+key([invoiceId,requestId]),
   operations:action==='review'?[O.read,O.review]:[O.read,O.review,O.approve],
   context:{actor,resource,fixtureContext:context},payload,
   apply:async(tx,p)=>{
    if(await resolveActor(context)!==p.actor)throw fail('CORE_FORBIDDEN');
    // Domain adapter must lock invoice and document/number uniqueness under this transaction.
    const current=await tx.lockInvoice(p.invoiceId);
    const prior=current?.revision??null;
    if((prior?.revision??0)!==p.expectedRevision||(prior?.fingerprint??null)!==p.expectedFingerprint)
     throw fail('INVOICE_REVISION_CONFLICT');
    const input=copy(await tx.loadInvoiceEvidence(p.invoiceId));
    if(input.header?.invoiceId!==p.invoiceId)throw fail('INVOICE_SCOPE_CONFLICT');
    const at=clock().toISOString();
    const built=buildDocumentInvoiceReview({...input,previousRevision:prior,expectedRevision:p.expectedRevision,recordedAt:at});
    if(action==='review'){
     if(built.state!=='review_required')throw fail('INVOICE_EVIDENCE_UNRESOLVED');
     const proposal=built.evidence.proposal;
     const resource={invoiceId:p.invoiceId,supplierId:proposal.supplierId,outletId:proposal.outletId};
     for(const operation of [O.read,O.review])if(await authorize({operation,context:{actor:p.actor,resource,fixtureContext:context},environment:'test',mode:'write'})!==true)throw fail('CORE_FORBIDDEN');
     // Stable identity claim excludes same invoice, rejects competing source/hash/number.
     if(await tx.reserveDocumentIdentity({invoiceId:p.invoiceId,sourceKey:key([input.document.source.provider,input.document.source.accountRef,input.document.source.messageId,input.document.attachment.id]),documentHash:proposal.documentHash,supplierId:proposal.supplierId,invoiceNumber:proposal.invoiceNumber})!==true)
      throw fail('INVOICE_DUPLICATE');
     await tx.saveInvoiceReview({invoiceId:p.invoiceId,revision:built.revision,evidence:built.evidence,reviewActor:p.actor,approval:null});
     return {invoiceId:p.invoiceId,revision:built.revision.revision,state:'review_recorded',executable:false};
    }
    // Rebuild original revision from trusted current input using its original timestamp
    // and predecessor. A changed source or catalog/PO/history version invalidates approval.
    if(!current||current.approval!==null)throw fail('INVOICE_APPROVAL_CONFLICT');
    const refreshed=buildDocumentInvoiceReview({...input,previousRevision:current.previousRevision??null,expectedRevision:prior.expectedPreviousRevision,recordedAt:prior.recordedAt});
    if(refreshed.state!=='review_required'||refreshed.revision.fingerprint!==prior.fingerprint)throw fail('INVOICE_EVIDENCE_CHANGED');
    const proposal=refreshed.evidence.proposal;
    const scoped={invoiceId:p.invoiceId,supplierId:proposal.supplierId,outletId:proposal.outletId};
    for(const operation of [O.read,O.review,O.approve])if(await authorize({operation,context:{actor:p.actor,resource:scoped,fixtureContext:context},environment:'test',mode:'write'})!==true)throw fail('CORE_FORBIDDEN');
    const approval={invoiceId:p.invoiceId,revision:prior.revision,fingerprint:prior.fingerprint,approvalRef:'fixture-'+key([p.actor,p.invoiceId,prior.revision,prior.fingerprint]),recordedAt:at,actor:p.actor};
    if(inspectApprovalBinding({revision:prior,approval,currentEvidence:refreshed.evidence,now:at,maxAgeMs}).state!=='binding_matches')throw fail('INVOICE_APPROVAL_STALE');
    await tx.saveInvoiceApproval({invoiceId:p.invoiceId,approval});
    // Intent is a review notification only; no PO execution, receiving or delivery.
    await tx.enqueueReviewIntent({id:key([p.invoiceId,prior.revision,'approval-recorded']),invoiceId:p.invoiceId,revision:prior.revision,kind:'invoice-review-approved',executable:false});
    return {invoiceId:p.invoiceId,revision:prior.revision,state:'approval_recorded',executable:false};
   }});
 }});
}
