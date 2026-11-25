import {prepareExecutionM7} from './localTransactionM7.js';
import {createLocalDomainAdapterM10} from './domainAdapterM10.js';
import {fingerprintLightspeedPayload as fp} from './idempotency.js';
import {identityTargets} from './invoicePersistenceM6.js';
import {projectSupplierDocument,inspectDocumentReplay,resolveDocumentSupplier,inspectInvoiceCatalogLink} from './supplierDocumentEvidence.js';
import {reconcileInvoice} from './invoiceReconciliation.js';
import {prepareInvoiceReviewRevision} from './invoiceReviewContract.js';
import {PURCHASING_FIXTURE_OPERATIONS as O} from './purchasingReviewWorkflow.js';
import {inspectCumulativeInvoiceQuantities} from './invoiceReviewContract.js';

// Isolated evidence ledger only. No vendor, stock, payment or remote effects.
const fail=code=>Object.assign(Error('P12 fixture refused'),{code});
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
  if(prior.some(r=>r.productId!==l.productId||r.variantId!==l.variantId||r.supplierItemId!==l.supplierItemId||r.supplierSku!==l.supplierSku))throw fail('INVOICE_BILLED_BASELINE_CHANGED');
  const t=totals.totals.find(r=>r.poLineId===l.poLineId);
  return {target:lineTarget(p,l),scope:{supplierId:p.supplierId,outletId:p.outletId,poId:p.targetPoId,poLineId:l.poLineId,
   productId:l.productId,variantId:l.variantId,supplierItemId:l.supplierItemId,supplierSku:l.supplierSku,poLineRevision:l.poLineRevision,variantRevision:l.variantRevision,supplierItemRevision:l.supplierItemRevision,orderedQty:l.orderedQty,poVersion:built.evidence.poVersion,
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

// Trusted source contract: independent exact supplier-item and variant/PO evidence.
// No parent fallback or inferred receipt. Complete source evidence is retained in the command.
function proposalFor(input,current,action,at){
 const d=projectSupplierDocument(input.document),h=input.header;
 if(d.state!=='staged_evidence'||d.kind!=='invoice'||inspectDocumentReplay(d,input.priorDocuments,{complete:input.documentHistoryComplete}).state!=='new_candidate')throw fail('INVOICE_SOURCE_UNRESOLVED');
 const supplier=resolveDocumentSupplier({document:d,aliasRows:input.aliasRows,complete:input.aliasCoverage});
 if(supplier.state!=='candidate'||supplier.supplierId!==h.supplierId||h.documentHash!==d.documentHash||!exact(h.reviewRef)||!d.references.includes(h.poReference))throw fail('INVOICE_SOURCE_UNRESOLVED');
 if(!Array.isArray(input.targets)||input.targets.length!==d.lines.length||!Array.isArray(input.supplierItems)||input.supplierItemCoverage!==true||!Array.isArray(input.variantEvidence)||input.variantCoverage!==true)throw fail('INVOICE_VARIANT_UNRESOLVED');
 const invoice={id:h.invoiceId,kind:'invoice',supplierId:h.supplierId,outletId:h.outletId,invoiceNumber:h.invoiceNumber,documentHash:d.documentHash,poReference:h.poReference,lines:d.lines};
 const association=reconcileInvoice({invoice,poList:input.poList,priorInvoices:input.priorInvoices,historyComplete:input.invoiceHistoryComplete});
 const po=input.poDetail;
 if(association.state!=='candidate'||association.mode!=='update_open'||po?.id!==association.targetPoId||po.supplier?.id!==h.supplierId||po.outletId!==h.outletId||po.poType!=='SUPPLIER'||po.purchasingStatus!=='OPEN'||po.source?.complete!==true||!Number.isFinite(Date.parse(po.source.readAt))||!Array.isArray(po.lines)||new Set(po.lines.map(l=>l.id)).size!==po.lines.length)throw fail('INVOICE_PO_UNRESOLVED');
 const lines=d.lines.map(l=>{
  const ts=input.targets.filter(t=>t.invoiceLineId===l.id);
  if(ts.length!==1)throw fail('INVOICE_VARIANT_UNRESOLVED');
  const t=ts[0];
  if(!exact(t.productId)||!(t.variantId===null||exact(t.variantId))||!exact(t.identityEvidenceRef)||!exact(t.reviewRef)||t.documentHash!==d.documentHash||!exact(t.poLineId)||!exact(t.supplierItemId))throw fail('INVOICE_VARIANT_UNRESOLVED');
  const variants=input.variantEvidence.filter(v=>v.productId===t.productId&&v.variantId===t.variantId);
  if(variants.length!==1||variants[0].verified!==true||variants[0].reference!==t.identityEvidenceRef||!exact(variants[0].revision)||(t.variantId===null&&variants[0].nonvariant!==true))throw fail('INVOICE_VARIANT_UNRESOLVED');
  const links=input.supplierItems.filter(x=>x.supplierId===h.supplierId&&(x.supplierItemId===t.supplierItemId||x.supplierSku===l.supplierSku));
  if(links.length!==1||links[0].verified!==true||links[0].supplierItemId!==t.supplierItemId||links[0].supplierSku!==l.supplierSku||links[0].productId!==t.productId||links[0].variantId!==t.variantId||!exact(links[0].revision))throw fail('INVOICE_SUPPLIER_ITEM_CONFLICT');
  const link=inspectInvoiceCatalogLink({supplier,line:l,target:t,rows:input.linkRows,complete:input.linkCoverage});
  if(link.state!=='candidate')throw fail('INVOICE_SUPPLIER_ITEM_CONFLICT');
  const candidates=po.lines.filter(x=>x.id===t.poLineId);
  const p=candidates[0];
  if(candidates.length!==1||p.productId!==t.productId||p.variantId!==t.variantId||p.supplierItemId!==t.supplierItemId||p.supplierSku!==l.supplierSku||!exact(p.revision)||!Number.isSafeInteger(p.orderedQty)||p.orderedQty<=0||typeof l.quantity!=='string'||!/^\d{1,12}$/.test(l.quantity)||Number(l.quantity)<=0||Number(l.quantity)>p.orderedQty||typeof l.unitCost!=='string'||!/^\d{1,12}(\.\d{1,6})?$/.test(l.unitCost)||!/^[A-Z]{3}$/.test(l.currency))throw fail('INVOICE_LINE_CONFLICT');
  return {invoiceLineId:l.id,productId:t.productId,variantId:t.variantId,supplierItemId:t.supplierItemId,supplierSku:l.supplierSku,poLineId:p.id,poLineRevision:p.revision,variantRevision:variants[0].revision,supplierItemRevision:links[0].revision,orderedQty:p.orderedQty,invoicedQty:Number(l.quantity),receivedQty:null,unitCost:l.unitCost,currency:l.currency,documentRef:l.documentRef,catalogEvidenceRef:fp({t,variant:variants[0],item:links[0],link})};
 });
 if(!lines.length||new Set(lines.map(l=>l.poLineId)).size!==lines.length||new Set(lines.map(l=>l.currency)).size!==1)throw fail('INVOICE_LINE_CONFLICT');
 const proposal={state:'review_required',mode:'update_open',targetPoId:po.id,supplierId:h.supplierId,outletId:h.outletId,invoiceId:h.invoiceId,invoiceNumber:h.invoiceNumber,documentHash:d.documentHash,poReadAt:po.source.readAt,proposedInitialStatus:null,lines,executable:false,requiresFullApproval:true};
 // Bind source metadata and all selected source bytes, not merely the caller's document hash.
 const sourceDigest=fp(input);
 const evidence={proposal,quantityEvidence:input.quantityEvidence,poVersion:input.poVersion,historyVersion:input.historyVersion,catalogVersion:input.catalogVersion,sourceDigest};
 const prior=current?.revision??null;
 const revision=prepareInvoiceReviewRevision({...evidence,previous:action==='approve'?current?.previousRevision??null:prior,expectedRevision:action==='approve'?prior?.expectedPreviousRevision:prior?.revision??0,reviewRef:h.reviewRef,recordedAt:action==='approve'?prior?.recordedAt:at});
 if(revision.state!=='review_required')throw fail('INVOICE_EVIDENCE_UNRESOLVED');
 return {state:'review_required',evidence,revision,receiving:{state:'UNKNOWN',receivedQty:null},executable:false};
}
export async function derivePurchasingIntentP12({tenant,actor,invoiceId,requestId,action,at,input,reversal:originalReversal,readTrustedRow,evidenceRef}){
  if(!exact(invoiceId)||!exact(requestId)||!['review','approve','reverse'].includes(action))throw fail('INVOICE_REQUEST_INVALID');
  if(actor.type!=='employee'||actor.realm!=='employee'||actor.tenant!==tenant||actor.delegation?.kind!=='none')throw fail('CORE_FORBIDDEN');
  const invoice=invoiceTarget(invoiceId),currentRow=await readTrustedRow(invoice),current=currentRow?.record??null;
  if(current&&(current.version!=='p12.m10'||current.revision.invoiceId!==invoiceId))throw fail('INVOICE_VERSION_CONFLICT');
  if(current?.reversal)throw fail('INVOICE_REVERSAL_REQUIRES_RECONCILIATION');
  if(action==='reverse'&&(!current?.approval))throw fail('INVOICE_REVERSAL_UNRESOLVED');
  if(action==='approve'&&(!current||current.approval!==null))throw fail('INVOICE_APPROVAL_CONFLICT');
  if(input.header?.invoiceId!==invoiceId)throw fail('INVOICE_SCOPE_CONFLICT');
  const proposalAction=action==='reverse'?'approve':action;
  const built=proposalFor(input,current,proposalAction,at);
  if(built.state!=='review_required')throw fail('INVOICE_EVIDENCE_UNRESOLVED');
  const p=built.evidence.proposal,ids=identityTargets(input,p),lines=linesFor(built);
  // Exact variant-aware OPEN PO evidence only; new PO proposals remain gated.
  if(p.mode!=='update_open'||!lines.length)throw fail('INVOICE_SCOPE_UNRESOLVED');
  if(current&&(!same(current.identityTargets,ids)||!same(current.lineTargets,lines.map(l=>l.target))||
   current.revision.supplierId!==p.supplierId||current.revision.outletId!==p.outletId))throw fail('INVOICE_IDENTITY_CHANGED');
  if(action!=='review'&&(built.revision.fingerprint!==current.revision.fingerprint||built.evidence.sourceDigest!==current.evidence.sourceDigest))throw fail('INVOICE_EVIDENCE_CHANGED');
  const revision=action==='review'?built.revision:current.revision,history=historyTarget(invoiceId,revision.revision,action);
  // Bounded reversal of local approval evidence only. Keep billed reservations held;
  // a credit document, payment reversal or release requires separate reconciliation.
  const reversal=action==='reverse'?copy(originalReversal):null;
  if(reversal&&(reversal.documentHash!==p.documentHash||reversal.sourceDigest!==built.evidence.sourceDigest||!exact(reversal.reference)||!exact(reversal.reasonCode)||reversal.invoiceId!==invoiceId||reversal.supplierId!==p.supplierId||reversal.outletId!==p.outletId||reversal.revision!==revision.revision||reversal.fingerprint!==revision.fingerprint||reversal.approvalRef!==current.approval.approvalRef))throw fail('INVOICE_REVERSAL_UNRESOLVED');
  if(action==='reverse'&&!reversal)throw fail('INVOICE_REVERSAL_UNRESOLVED');
  const reversalIdentity=reversal?target('purchasing.invoice.reversal-reference',fp([p.supplierId,reversal.reference])):null;
  const originalApprovalTarget=reversal?historyTarget(invoiceId,revision.revision,'approve'):null;
  const targets=[invoice,...ids,history,...lines.map(l=>l.target),...(reversalIdentity?[reversalIdentity,originalApprovalTarget]:[])];
  const rows=new Map([[key(invoice),currentRow??null],[key(history),null]]);
  if(originalApprovalTarget){const old=await readTrustedRow(originalApprovalTarget);if(!old||!same(old.record,{invoiceId,approval:current.approval}))throw fail('INVOICE_APPROVAL_CONFLICT');rows.set(key(originalApprovalTarget),old);}
  if(reversalIdentity){const prior=await readTrustedRow(reversalIdentity);if(prior)throw fail('INVOICE_DUPLICATE');rows.set(key(reversalIdentity),null);}
  for(const t of ids)rows.set(key(t),await readTrustedRow(t)??null);
  for(const l of lines)rows.set(key(l.target),await readTrustedRow(l.target)??null);
  for(const t of ids){const r=rows.get(key(t));if(current?r?.record?.invoiceId!==invoiceId:r!==null)throw fail('INVOICE_DUPLICATE');}
  const planned=lines.map(l=>nextLine(l,rows.get(key(l.target)),invoiceId,revision.revision,proposalAction,current));
  const effect=(operation,t,fields)=>({operation,target:t,location:p.outletId,fields});
  const operations=action==='review'?[O.review]:action==='approve'?[O.review,O.approve]:[O.review,'purchasing.invoice.approval.reverse'];
  const effects=operations.flatMap(op=>targets.map(t=>effect(op,t,[t.type==='purchasing.po.billed-line'?'billed-quantity':'evidence'])));
  const execution=prepareExecutionM7({tenant,scope:'test.purchasing.invoice',key:'invoice-'+fp([invoiceId,requestId]),actor,targets,effects,
   expectedRevisions:targets.map(t=>({target:t,revision:rows.get(key(t))?.revision??null})),
   payload:{invoiceId,action,supplierId:p.supplierId,outletId:p.outletId,revision:revision.revision,fingerprint:revision.fingerprint,
    prior:fp(current),recordedAt:at,documentHash:p.documentHash,invoiceNumber:p.invoiceNumber,reviewRef:revision.reviewRef,originalApproval:current?.approval?.approvalRef??null,sourceDigest:built.evidence.sourceDigest,reversal,proposalLines:p.lines,lines:lines.map(l=>({scope:l.scope,quantity:l.quantity})),identities:ids}});
  const readEffects=[effect(O.read,invoice,['receipt'])];
  const reconcileEffects=[effect('purchasing.invoice.receipt.inspect',invoice,['receipt'])];
  const relation=(type,id)=>({type,id});
  const decimal=s=>{const [i,f='']=s.split('.');const fraction=f.replace(/0+$/,'');return String(BigInt(i))+(fraction?'.'+fraction:'');};
  const map=es=>es.flatMap(e=>e.fields.map(field=>{
    const l=lines.find(l=>key(l.target)===key(e.target));
    const line=l?p.lines.find(x=>x.poLineId===l.scope.poLineId):null;
    const relationships=[relation('supplier',p.supplierId),relation('invoice',invoiceId),relation('invoice-number',p.invoiceNumber),
      relation('document',p.documentHash),relation('review',revision.reviewRef),relation('review-fingerprint',revision.fingerprint),relation('source-digest',built.evidence.sourceDigest),
      relation('history-version',built.evidence.historyVersion),relation('catalog-version',built.evidence.catalogVersion)];
    if(current?.approval)relationships.push(relation('original-approval',current.approval.approvalRef));
    if(reversal)relationships.push(relation('reversal',reversal.reference),relation('reversal-reason',reversal.reasonCode));
    if(p.targetPoId)relationships.push(relation('po',p.targetPoId),relation('po-version',built.evidence.poVersion));
    if(line)relationships.push(relation('po-line',line.poLineId),relation('invoice-line',line.invoiceLineId),relation('product',line.productId),relation('variant-kind',line.variantId===null?'nonvariant':'variant'),...(line.variantId===null?[]:[relation('variant',line.variantId)]),relation('variant-revision',line.variantRevision),relation('supplier-item',line.supplierItemId),relation('supplier-item-revision',line.supplierItemRevision),relation('po-line-revision',line.poLineRevision),relation('catalog-evidence',line.catalogEvidenceRef),relation('supplier-sku',line.supplierSku),relation('ordered-quantity',String(line.orderedQty)),relation('received-quantity','not-observed'));
    return {operation:e.operation,tenant,environment:'test',location:e.location,resourceType:e.target.type,resourceId:e.target.id,field,
      revision:String(revision.revision),relationships,quantity:line?String(line.invoicedQty):null,
      amount:line?decimal(line.unitCost):null,currency:line?line.currency:null,purpose:'invoice-evidence',audience:'purchasing'};
  }));
  const facts=copy({evidenceRef,executionEffects:map(execution.effects),readEffects:map(readEffects),inspectEffects:map(reconcileEffects)});
  return {execution,readEffects,reconcileEffects,facts,rows:[...rows],planned,targets,ids,history,lines,invoice,current,currentRow,revision,built,reversal,reversalIdentity,action,at,actor,invoiceId};
}
export function createPurchasingDomainAdapterP12({tenant,resolveActor,readOriginal,readFresh,resolveEvidenceRef,security,decide,readPolicyVersion,clock,transaction,auditDenied,inspectCommitted}={}){
 if(![resolveActor,readOriginal,readFresh,resolveEvidenceRef,decide,readPolicyVersion,clock].every(f=>typeof f==='function'))throw TypeError('Trusted adapters required');
 return Object.freeze({async run({context,request}={}){
  if(!request||Object.keys(request).length!==1||!exact(request.requestId))return {state:'undisclosed',retryAllowed:false};
  let original,plan,proof;
  try{
   const actor=copy(await resolveActor(context));
   original=copy(await readOriginal(context,request.requestId));
   if(original.requestId!==request.requestId||!same(original.actor,actor)||original.evidenceRef!==await resolveEvidenceRef(context)||!Number.isFinite(Date.parse(original.at)))throw fail('INVOICE_SCOPE_CONFLICT');
   if(!Array.isArray(original.rows)||new Set(original.rows.map(r=>r[0])).size!==original.rows.length)throw fail('INVOICE_SCOPE_CONFLICT');
   const stored=new Map(original.rows);
   plan=await derivePurchasingIntentP12({...original,tenant,readTrustedRow:t=>stored.get(key(t))??null});
   proof=copy(original.approval);
   if(!same(original.rows,plan.rows)||proof.executionDigest!==fp(plan.execution)||!exact(proof.reference)||!Number.isSafeInteger(proof.expiresAt)||!exact(proof.reviewerId)||proof.reviewerId===actor.id||clock()>=proof.expiresAt)throw fail('CORE_FORBIDDEN');
  }catch{return {state:'undisclosed',retryAllowed:false};}
  const {execution,readEffects,reconcileEffects,facts,rows,planned,targets,ids,history,lines,invoice,current,currentRow,revision,built,reversal,reversalIdentity,action,at,actor,invoiceId}=plan;
  const rowMap=new Map(rows);
  const approval=action==='approve'?{invoiceId,revision:revision.revision,fingerprint:revision.fingerprint,approvalRef:proof.reference,recordedAt:at,actor:actor.id,reviewerId:proof.reviewerId,executionDigest:fp(execution)}:null;
  const adapter=createLocalDomainAdapterM10({tenant,resolveActor,resolvePrepared:()=>({execution,approval:proof,readEffects,reconcileEffects}),
   authorizationOptions:{security,readPolicyVersion,clock,deriveScope:()=>facts,decide:async q=>{
    if(!same(await resolveActor(context),actor)||await resolveEvidenceRef(context)!==facts.evidenceRef||clock()>=proof.expiresAt)return {allowed:false};
    return decide(q);
   }},transaction,auditDenied,inspectCommitted,receiptSchema:{version:'purchasing.receipt.v1',fields:['invoiceId','revision','outcome']},projectResult:()=>({}),
   verifyExecution:async({evidence})=>{
    if(targets.some(t=>!same(evidence.find(x=>key(x.target)===key(t))?.row??null,rowMap.get(key(t)))))return false;
    const fresh=copy(await readFresh(context,invoiceId,action));
    return same(fresh.input,original.input)&&same(fresh.reversal??null,original.reversal??null);
   },
   apply:async tx=>{
    if(!current)for(const t of ids)await tx.insertDomain({...t,record:{invoiceId}});
    const record=action==='review'?{version:'p12.m10',revision:built.revision,evidence:built.evidence,reviewActor:actor.id,
     previousRevision:current?.revision??null,sourceEvidence:original.input,correctionOf:current?{revision:current.revision.revision,fingerprint:current.revision.fingerprint,approvalRef:current.approval?.approvalRef??null}:null,approval:null,identityTargets:ids,lineTargets:lines.map(l=>l.target)}:action==='approve'?{...current,approval}:{...current,approval:null,reversal:{...reversal,recordedAt:at,actor:actor.id,proofRef:proof.reference,originalApproval:current.approval,reservationState:'held'}};
    if(action==='review')for(let i=0;i<lines.length;i++){
     const t=lines[i].target,old=rowMap.get(key(t));
     if(old)await tx.replaceDomain({...t,expectedRevision:old.revision,record:planned[i]});
     else await tx.insertDomain({...t,record:planned[i]});
    }
    if(reversalIdentity)await tx.insertDomain({...reversalIdentity,record:{invoiceId,reference:reversal.reference}});
    await tx.insertDomain({...history,record:action==='review'?record:action==='approve'?{invoiceId,approval}:{invoiceId,reversal:record.reversal}});
    if(current)await tx.replaceDomain({...invoice,expectedRevision:currentRow.revision,record});
    else await tx.insertDomain({...invoice,record});
    if(approval)await tx.enqueueCanonical({id:fp([tenant,invoiceId,revision.revision,'approval-recorded']),record:{kind:'invoice-review-approved',invoiceId,revision:revision.revision,fingerprint:revision.fingerprint,approvalRef:approval.approvalRef,executable:false}});
    return {invoiceId,revision:revision.revision,outcome:action==='review'?'review_recorded':action==='approve'?'approval_recorded':'reversal_recorded'};
   }});
  return adapter.run({context,request});
 }});
}
