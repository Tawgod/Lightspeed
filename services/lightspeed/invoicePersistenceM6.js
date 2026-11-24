import {createLocalTransactionM6} from './localTransactionM6.js';
import {fingerprintLightspeedPayload as fp} from './idempotency.js';
import {buildDocumentInvoiceReview,PURCHASING_FIXTURE_OPERATIONS as O} from './purchasingReviewWorkflow.js';
import {inspectApprovalBinding} from './invoiceReviewContract.js';

// Offline-only composition; trusted fixture inputs, never a route or production writer.
// Core owns transaction, locks, audit, replay and outbox; Security owns all decisions.
const fail=code=>Object.assign(Error('Purchasing fixture refused.'),{code});
const exact=x=>typeof x==='string'&&x.length>0&&x.length<=256&&x.trim()===x&&!/[\x00-\x1f\x7f]/.test(x);
const copy=x=>{fp(x);return JSON.parse(JSON.stringify(x));};
const target=(type,id)=>({type,id});
const k=t=>JSON.stringify([t.type,t.id]);
const same=(a,b)=>fp(a)===fp(b);
const currentTarget=id=>target('purchasing.invoice',id);
const historyTarget=(id,revision,action)=>target('purchasing.invoice.'+action,fp([id,revision]));
function identityTargets(input,proposal){
 const s=input.document.source,a=input.document.attachment;
 return [
  target('purchasing.document.source',fp([s.provider,s.accountRef,s.messageId,a.id])),
  target('purchasing.document.hash',proposal.documentHash),
  target('purchasing.invoice.number',fp([proposal.supplierId,proposal.invoiceNumber]))
 ];
}
function proposalFor(input,current,action,at){
 const prior=current?.revision??null;
 return buildDocumentInvoiceReview({...input,previousRevision:action==='approve'?current?.previousRevision??null:prior,
  expectedRevision:action==='approve'?prior?.expectedPreviousRevision:prior?.revision??0,
  recordedAt:action==='approve'?prior?.recordedAt:at});
}
export function isCurrentInvoiceReviewIntent({intent,current}={}){
 return Boolean(intent&&current&&intent.kind==='invoice-review-approved'&&intent.executable===false&&
  current.approval&&current.revision?.invoiceId===intent.invoiceId&&current.revision.revision===intent.revision&&
  current.revision.fingerprint===intent.fingerprint&&current.approval.approvalRef===intent.approvalRef);
}
export function createInvoicePersistenceM6({tenant,transaction,authorize,authorizeRead,authorizeReconcile,auditDenied,inspectCommitted,
 resolveActor,loadEvidence,verifyReviewer,clock=()=>new Date(),maxAgeMs=120000,strictP09=false}={}){
 if(![resolveActor,loadEvidence,verifyReviewer,authorize,authorizeRead,authorizeReconcile].every(f=>typeof f==='function')||
 !Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0)throw TypeError('Trusted synthetic adapters required');
 // Domain plan is derived exclusively from fixture evidence, not request claims. The prepared
 // closure retains its original command so replay never substitutes a newer revision or timestamp.
 return Object.freeze({async prepare({context,invoiceId,requestId,action,currentRow=null}={}){
  if(!exact(invoiceId)||!exact(requestId)||!['review','approve'].includes(action))throw fail('INVOICE_REQUEST_INVALID');
  const actor=copy(await resolveActor(context));
  if(actor.type!=='employee'||actor.realm!=='employee'||actor.tenant!==tenant||actor.delegation?.kind!=='none'||!exact(actor.id))throw fail('CORE_FORBIDDEN');
  const at=clock().toISOString(),current=currentRow===null?null:copy(currentRow.record),storageRevision=currentRow?.revision??null;
  if(currentRow!==null&&(!Number.isSafeInteger(storageRevision)||storageRevision<1||current?.revision?.invoiceId!==invoiceId))throw fail('INVOICE_SCOPE_CONFLICT');
  if(action==='approve'&&(!current||current.approval!==null))throw fail('INVOICE_APPROVAL_CONFLICT');
  const input=copy(await loadEvidence(invoiceId));
  if(input.header?.invoiceId!==invoiceId)throw fail('INVOICE_SCOPE_CONFLICT');
  const built=proposalFor(input,current,action,at);
  if(built.state!=='review_required')throw fail('INVOICE_EVIDENCE_UNRESOLVED');
  const proposal=built.evidence.proposal,ids=identityTargets(input,proposal),invoice=currentTarget(invoiceId);
  if(current&&(!same(current.identityTargets,ids)||current.revision.supplierId!==proposal.supplierId||current.revision.outletId!==proposal.outletId))throw fail('INVOICE_IDENTITY_CHANGED');
  if(action==='approve'&&built.revision.fingerprint!==current.revision.fingerprint)throw fail('INVOICE_EVIDENCE_CHANGED');
  const revision=action==='approve'?current.revision:built.revision;
  const history=historyTarget(invoiceId,revision.revision,action);
  const approval=action==='approve'?{invoiceId,revision:revision.revision,fingerprint:revision.fingerprint,
   approvalRef:'fixture-'+fp([tenant,actor,invoiceId,revision.revision,revision.fingerprint,requestId]),recordedAt:at,actor:actor.id}:null;
  const targets=[invoice,...ids,history];
  const expectedRevisions=targets.map(t=>({target:t,revision:k(t)===k(invoice)?storageRevision:k(t)===k(history)?null:current?1:null}));
  const effect=(operation,t,fields)=>({operation,target:t,location:proposal.outletId,fields});
  const operations=action==='review'?[O.read,O.review]:[O.read,O.review,O.approve];
  const effects=operations.flatMap(op=>targets.map(t=>effect(op,t,[k(t)===k(invoice)?'review':k(t)===k(history)?'history':'identity'])));
  const readEffects=[effect(O.read,invoice,['receipt'])];
  // Proposed existing reconciliation capability, scoped here to local command receipts;
  // actual registry scope and any separation from remote reconciliation are Security-owned.
  const reconcileEffects=[effect(strictP09?'purchasing.invoice.receipt.inspect':'purchasing.invoice.reconcile-unknown',invoice,['receipt']),effect('purchasing.audit.read',invoice,['receipt'])];
  const checkActor=async()=>same(await resolveActor(context),actor);
  const reviewAuthority=async()=>approval===null||await verifyReviewer({context,actor,approval:copy(approval),revision:copy(revision),tenant})===true;
  const wrap=adapter=>async q=>{
   if(!await checkActor()||!await reviewAuthority()||await adapter(q)!==true)return false;
   if(strictP09){
    // Check again after the injected decision, including the final precommit stage.
    // This narrows the synthetic race, not a distributed authorization fence.
    if(!await checkActor()||!await reviewAuthority())return false;
    if(approval&&['beforeCommit','beforeDisclosure','readProjection','afterProjection','beforeReconcile','reconcile'].includes(q.stage)){
     const age=clock().getTime()-Date.parse(approval.recordedAt);
     if(!Number.isFinite(age)||age<0||age>maxAgeMs)return false;
    }
   }
   return true;
  };
  const run=createLocalTransactionM6({tenant,transaction,authorize:wrap(authorize),authorizeRead:wrap(authorizeRead),
   authorizeReconcile:wrap(authorizeReconcile),auditDenied,inspectCommitted});
  const payload={invoiceId,action,supplierId:proposal.supplierId,outletId:proposal.outletId,
   revision:revision.revision,fingerprint:revision.fingerprint,recordedAt:at,prior:fp(current),identities:ids};
  const command={scope:'test.purchasing.invoice',key:'invoice-'+fp([invoiceId,requestId]),actor,targets,effects,readEffects,reconcileEffects,
   expectedRevisions,approval,payload,receiptFields:['invoiceId','revision','outcome'],
   verifyLocked:async({evidence})=>{
    const row=t=>evidence.find(x=>k(x.target)===k(t))?.row;
    if(!same(row(invoice)?.record??null,current)||row(history)!==null)return false;
    for(const t of ids){const existing=row(t);if(current?existing?.record?.invoiceId!==invoiceId:existing!==null)return false;}
    const fresh=copy(await loadEvidence(invoiceId)),again=proposalFor(fresh,current,action,at);
    if(again.state!=='review_required'||!same(again,built)||!same(identityTargets(fresh,again.evidence.proposal),ids))return false;
    if(action==='approve'&&(await reviewAuthority()!==true||inspectApprovalBinding({revision,approval,currentEvidence:again.evidence,
     now:clock().toISOString(),maxAgeMs}).state!=='binding_matches'))return false;
    return true;
   },
   apply:async tx=>{
    if(!current)for(const t of ids)await tx.insertDomain({...t,record:{invoiceId}});
    const record=action==='review'?{revision:built.revision,evidence:built.evidence,reviewActor:actor.id,
     previousRevision:current?.revision??null,approval:null,identityTargets:ids}:{...current,approval};
    // Immutable history rows are inserted only; the current pointer alone may advance.
    await tx.insertDomain({...history,record:action==='review'?record:{invoiceId,approval}});
    if(current)await tx.replaceDomain({...invoice,expectedRevision:storageRevision,record});
    else await tx.insertDomain({...invoice,record});
    if(action==='approve'){
     const intent={kind:'invoice-review-approved',invoiceId,revision:revision.revision,fingerprint:revision.fingerprint,
      approvalRef:approval.approvalRef,executable:false};
     await tx.enqueueCanonical({id:fp([tenant,invoiceId,revision.revision,'approval-recorded']),record:intent});
    }
    return {invoiceId,revision:revision.revision,outcome:action==='review'?'review_recorded':'approval_recorded'};
   },
   projectResult:r=>{
    if(strictP09&&(r.invoiceId!==invoiceId||r.revision!==revision.revision||r.outcome!==(action==='review'?'review_recorded':'approval_recorded')))throw fail('INVOICE_RECEIPT_SCOPE_CONFLICT');
    return {invoiceId:r.invoiceId,revision:r.revision,state:r.outcome,executable:false};
   }};
  return Object.freeze({submit:()=>run(command)});
 }});
}
