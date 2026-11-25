import {prepareExecutionM7,createLocalTransactionM7} from './localTransactionM7.js';
import {fingerprintLightspeedPayload as fp} from './idempotency.js';
import {identityTargets,proposalFor} from './invoicePersistenceM6.js';
import {PURCHASING_FIXTURE_OPERATIONS as O} from './purchasingReviewWorkflow.js';
import {inspectApprovalBinding,inspectCumulativeInvoiceQuantities} from './invoiceReviewContract.js';

// Isolated evidence ledger only. No vendor, stock, payment or remote effects.
const fail=code=>Object.assign(Error('P10 fixture refused'),{code});
const copy=x=>{fp(x);return JSON.parse(JSON.stringify(x));};
const same=(a,b)=>fp(a)===fp(b);
const exact=x=>typeof x==='string'&&x.length>0&&x.length<=256&&x.trim()===x&&!/[\x00-\x1f\x7f]/.test(x);
const target=(type,id)=>({type,id}), key=t=>JSON.stringify([t.type,t.id]);
const invoiceTarget=id=>target('purchasing.invoice',id);
const historyTarget=(id,rev,action)=>target('purchasing.invoice.'+action,fp([id,rev]));
const lineTarget=(p,l)=>target('purchasing.po.billed-line',fp([p.supplierId,p.outletId,p.targetPoId,l.poLineId]));
function linesFor(built){
 const p=built.evidence.proposal;
 if(p.mode!=='update_open')return [];
 const q=built.evidence.quantityEvidence;
 const totals=inspectCumulativeInvoiceQuantities({proposal:p,priorLines:q.priorLines,coverageComplete:q.coverageComplete});
 if(totals.state!=='candidate')throw fail('INVOICE_EVIDENCE_UNRESOLVED');
 return p.lines.map(l=>{
  const prior=q.priorLines.filter(r=>r.poLineId===l.poLineId);
  const t=totals.totals.find(r=>r.poLineId===l.poLineId);
  return {target:lineTarget(p,l),scope:{supplierId:p.supplierId,outletId:p.outletId,poId:p.targetPoId,poLineId:l.poLineId,
   productId:l.productId,variantId:null,orderedQty:l.orderedQty,poVersion:built.evidence.poVersion,
   historyVersion:built.evidence.historyVersion,priorDigest:fp(prior),priorQty:t.priorInvoicedQty},quantity:l.invoicedQty,
   priorInvoiceIds:[...new Set(prior.map(r=>r.invoiceId))]};
 });
}
function nextLine(line,prior,invoiceId,revision,action,current){
 const record=prior?.record??null;
 if(record&&!same(record.scope,line.scope))throw fail('INVOICE_BILLED_BASELINE_CHANGED');
 const reservations=record?.reservations??[];
 if(!Array.isArray(reservations)||reservations.some(r=>!exact(r.invoiceId)||!Number.isSafeInteger(r.quantity)||r.quantity<=0||
  !Number.isSafeInteger(r.revision)||r.revision<=0)||new Set(reservations.map(r=>r.invoiceId)).size!==reservations.length||
  reservations.some(r=>line.priorInvoiceIds.includes(r.invoiceId)))throw fail('INVOICE_BILLED_BASELINE_CHANGED');
 const old=reservations.find(r=>r.invoiceId===invoiceId);
 if(current?(!old||old.revision!==current.revision.revision):Boolean(old))throw fail('INVOICE_BILLED_REVISION_CONFLICT');
 if(action==='approve'&&old.quantity!==line.quantity)throw fail('INVOICE_BILLED_REVISION_CONFLICT');
 const next=reservations.filter(r=>r.invoiceId!==invoiceId).concat({invoiceId,revision,quantity:line.quantity});
 const sum=next.reduce((n,r)=>n+r.quantity,line.scope.priorQty);
 if(!Number.isSafeInteger(sum)||sum>line.scope.orderedQty)throw fail('INVOICE_BILLED_CAPACITY');
 return {scope:line.scope,reservations:next};
}
export function createInvoicePersistenceM7({tenant,transaction,authorizeExecution,authorizeAccess,auditDenied,inspectCommitted,
 resolveActor,loadEvidence,readTrustedRow,issueProof,verifyReviewer,clock=()=>new Date(),maxAgeMs=120000}={}){
 if(![resolveActor,loadEvidence,readTrustedRow,issueProof,verifyReviewer,authorizeExecution,authorizeAccess].every(f=>typeof f==='function')||
 !Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0)throw TypeError('Trusted fixture adapters required');
 return Object.freeze({async prepare({context,invoiceId,requestId,action}={}){
  if(!exact(invoiceId)||!exact(requestId)||!['review','approve'].includes(action))throw fail('INVOICE_REQUEST_INVALID');
  const actor=copy(await resolveActor(context));
  if(actor.type!=='employee'||actor.realm!=='employee'||actor.tenant!==tenant||actor.delegation?.kind!=='none')throw fail('CORE_FORBIDDEN');
  const at=clock().toISOString(),invoice=invoiceTarget(invoiceId),currentRow=await readTrustedRow(invoice),current=currentRow?.record??null;
  if(current&&(current.version!=='p10.m7'||current.revision.invoiceId!==invoiceId))throw fail('INVOICE_VERSION_CONFLICT');
  if(action==='approve'&&(!current||current.approval!==null))throw fail('INVOICE_APPROVAL_CONFLICT');
  const input=copy(await loadEvidence(invoiceId));
  if(input.header?.invoiceId!==invoiceId)throw fail('INVOICE_SCOPE_CONFLICT');
  const built=proposalFor(input,current,action,at);
  if(built.state!=='review_required')throw fail('INVOICE_EVIDENCE_UNRESOLVED');
  const p=built.evidence.proposal,ids=identityTargets(input,p),lines=linesFor(built);
  if(current&&(!same(current.identityTargets,ids)||!same(current.lineTargets,lines.map(l=>l.target))||
   current.revision.supplierId!==p.supplierId||current.revision.outletId!==p.outletId))throw fail('INVOICE_IDENTITY_CHANGED');
  if(action==='approve'&&built.revision.fingerprint!==current.revision.fingerprint)throw fail('INVOICE_EVIDENCE_CHANGED');
  const revision=action==='approve'?current.revision:built.revision,history=historyTarget(invoiceId,revision.revision,action);
  const targets=[invoice,...ids,history,...lines.map(l=>l.target)];
  const rows=new Map([[key(invoice),currentRow??null],[key(history),null]]);
  for(const t of ids)rows.set(key(t),await readTrustedRow(t)??null);
  for(const l of lines)rows.set(key(l.target),await readTrustedRow(l.target)??null);
  for(const t of ids){const r=rows.get(key(t));if(current?r?.record?.invoiceId!==invoiceId:r!==null)throw fail('INVOICE_DUPLICATE');}
  const planned=lines.map(l=>nextLine(l,rows.get(key(l.target)),invoiceId,revision.revision,action,current));
  const effect=(operation,t,fields)=>({operation,target:t,location:p.outletId,fields});
  const operations=action==='review'?[O.read,O.review]:[O.read,O.review,O.approve];
  const effects=operations.flatMap(op=>targets.map(t=>effect(op,t,[t.type==='purchasing.po.billed-line'?'billed-quantity':'evidence'])));
  const execution=prepareExecutionM7({tenant,scope:'test.purchasing.invoice',key:'invoice-'+fp([invoiceId,requestId]),actor,targets,effects,
   expectedRevisions:targets.map(t=>({target:t,revision:rows.get(key(t))?.revision??null})),
   payload:{invoiceId,action,supplierId:p.supplierId,outletId:p.outletId,revision:revision.revision,fingerprint:revision.fingerprint,
    prior:fp(current),recordedAt:at,lines:lines.map(l=>({scope:l.scope,quantity:l.quantity})),identities:ids}});
  const proof=copy(await issueProof({context,execution,revision:copy(revision)}));
  const approval=action==='approve'?{invoiceId,revision:revision.revision,fingerprint:revision.fingerprint,approvalRef:proof.reference,
   recordedAt:at,actor:actor.id,reviewerId:proof.reviewerId,executionDigest:fp(execution)}:null;
  const actorCurrent=async()=>same(await resolveActor(context),actor);
  const run=createLocalTransactionM7({tenant,transaction,auditDenied,inspectCommitted,
   authorizeExecution:async q=>await actorCurrent()&&await authorizeExecution(q)===true,
   verifyApproval:async q=>{
    if(!await actorCurrent()||!same(q.approval,proof)||q.digest!==fp(execution)||await verifyReviewer({context,...q})!==true)return false;
    const now=clock().getTime();
    return Number.isSafeInteger(now)&&now>=Date.parse(at)&&now<proof.expiresAt&&now-Date.parse(at)<=maxAgeMs;
   },
   authorizeAccess:async q=>await actorCurrent()&&await authorizeAccess(q)===true,
   receiptSchema:{version:'purchasing.receipt.v1',fields:['invoiceId','revision','outcome']},
   // Core M7 deliberately forbids nonempty multi-target projection.
   projectResult:()=>({})});
  const readEffects=[effect(O.read,invoice,['receipt'])];
  const reconcileEffects=[effect('purchasing.invoice.receipt.inspect',invoice,['receipt']),effect('purchasing.audit.read',invoice,['receipt'])];
  return Object.freeze({submit:()=>run({execution,approval:proof,readEffects,reconcileEffects,
   verifyExecution:async({evidence})=>{
    const row=t=>evidence.find(x=>key(x.target)===key(t))?.row??null;
    if(targets.some(t=>!same(row(t),rows.get(key(t)))))return false;
    const fresh=copy(await loadEvidence(invoiceId)),again=proposalFor(fresh,current,action,at);
    if(again.state!=='review_required'||!same(again,built)||!same(identityTargets(fresh,again.evidence.proposal),ids)||!same(linesFor(again),lines))return false;
    if(approval&&inspectApprovalBinding({revision,approval,currentEvidence:again.evidence,now:clock().toISOString(),maxAgeMs}).state!=='binding_matches')return false;
    return lines.every((l,i)=>same(nextLine(l,row(l.target),invoiceId,revision.revision,action,current),planned[i]));
   },
   apply:async tx=>{
    if(!current)for(const t of ids)await tx.insertDomain({...t,record:{invoiceId}});
    const record=action==='review'?{version:'p10.m7',revision:built.revision,evidence:built.evidence,reviewActor:actor.id,
     previousRevision:current?.revision??null,approval:null,identityTargets:ids,lineTargets:lines.map(l=>l.target)}:{...current,approval};
    for(let i=0;i<lines.length;i++){
     const t=lines[i].target,old=rows.get(key(t));
     if(action==='review'){
      if(old)await tx.replaceDomain({...t,expectedRevision:old.revision,record:planned[i]});
      else await tx.insertDomain({...t,record:planned[i]});
     }
    }
    await tx.insertDomain({...history,record:action==='review'?record:{invoiceId,approval}});
    if(current)await tx.replaceDomain({...invoice,expectedRevision:currentRow.revision,record});
    else await tx.insertDomain({...invoice,record});
    if(approval)await tx.enqueueCanonical({id:fp([tenant,invoiceId,revision.revision,'approval-recorded']),
     record:{kind:'invoice-review-approved',invoiceId,revision:revision.revision,fingerprint:revision.fingerprint,approvalRef:approval.approvalRef,executable:false}});
    return {invoiceId,revision:revision.revision,outcome:action==='review'?'review_recorded':'approval_recorded'};
   }})});
 }});
}
