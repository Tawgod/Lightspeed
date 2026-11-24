import {projectSupplierDocument,inspectDocumentReplay,resolveDocumentSupplier,inspectInvoiceCatalogLink} from './supplierDocumentEvidence.js';
import {prepareInvoiceProposal} from './invoiceReconciliation.js';
import {prepareInvoiceReviewRevision,inspectApprovalBinding} from './invoiceReviewContract.js';
import {fingerprintLightspeedPayload} from './idempotency.js';

// Offline composition; labels are proposed canonical operations, NOT Security registry grants.
// All sources and callbacks are server-owned synthetic fixtures. No writer or route.
const exact=x=>typeof x==='string'&&x.length>0&&x.trim()===x&&!/[\x00-\x1f\x7f]/.test(x);
const stop=reason=>({state:'needs_review',reason,executable:false});
const copy=x=>{fingerprintLightspeedPayload(x);return JSON.parse(JSON.stringify(x));};
const channels=new Set(['product-manager','scanner','ordering','po-companion','special-orders','direct-api','import','automation']);
export const PURCHASING_FIXTURE_OPERATIONS=Object.freeze({
 read:'purchasing.invoice.read',review:'purchasing.invoice.review',approve:'purchasing.invoice.approve',
 execute:'purchasing.invoice.execute',createPO:'purchasing.po.create',updatePO:'purchasing.po.update',
 cost:'catalog.cost.modify',createProduct:'catalog.product.create',supplierLink:'catalog.supplier.link.modify'
});
const O=PURCHASING_FIXTURE_OPERATIONS;
export function buildDocumentInvoiceReview(input){
 try{
 const d=projectSupplierDocument(input.document);
 if(d.state!=='staged_evidence'||d.kind!=='invoice')return stop('invoice_document_unresolved');
 if(inspectDocumentReplay(d,input.priorDocuments,{complete:input.documentHistoryComplete}).state!=='new_candidate')return stop('document_replay_or_history_unresolved');
 const s=resolveDocumentSupplier({document:d,aliasRows:input.aliasRows,complete:input.aliasCoverage});
 if(s.state!=='candidate')return stop('supplier_unresolved');
 // Invoice number/outlet/reference and target product selection are separate reviewed fixture evidence.
 const h=input.header;
 if(!exact(h?.invoiceId)||!exact(h.invoiceNumber)||!exact(h.outletId)||!exact(h.reviewRef)||
 h.documentHash!==d.documentHash||h.supplierId!==s.supplierId||
 !(h.poReference===null||d.references.includes(h.poReference)))return stop('header_review_unresolved');
 if(!Array.isArray(input.targets)||input.targets.length!==d.lines.length||!d.lines.length)return stop('catalog_targets_unresolved');
 const matches=[],lines=[];
 for(const l of d.lines){
 const ts=input.targets.filter(t=>t?.invoiceLineId===l.id);
 if(ts.length!==1)return stop('catalog_target_ambiguous');
 const t=ts[0];
 // V3 PO proposal has no variant ID: fail closed, do not collapse variant into parent.
 if(t.variantId!==null||!exact(t.reviewRef)||t.documentHash!==d.documentHash||
 !exact(t.productId)||!exact(t.identityEvidenceRef))return stop('catalog_identity_unresolved');
 const link=inspectInvoiceCatalogLink({supplier:s,line:l,target:t,rows:input.linkRows,complete:input.linkCoverage});
 if(link.state!=='candidate')return stop('catalog_link_unresolved');
 if(typeof l.quantity!=='string'||!/^[0-9]+$/.test(l.quantity)||!Number.isSafeInteger(Number(l.quantity))||Number(l.quantity)<=0)return stop('quantity_unresolved');
 lines.push({id:l.id,supplierSku:l.supplierSku,invoicedQty:Number(l.quantity),unitCost:l.unitCost,currency:l.currency,documentRef:l.documentRef});
 matches.push({invoiceLineId:l.id,state:'verified',productId:t.productId,supplierId:s.supplierId,supplierSku:l.supplierSku,relationship:'existing',
 evidenceRef:fingerprintLightspeedPayload({documentHash:d.documentHash,headerReview:h.reviewRef,supplierEvidence:s.evidence,target:t,link})});
 }
 const invoice={id:h.invoiceId,kind:'invoice',supplierId:s.supplierId,outletId:h.outletId,invoiceNumber:h.invoiceNumber,documentHash:d.documentHash,poReference:h.poReference,lines};
 const proposal=prepareInvoiceProposal({invoice,poList:input.poList,poDetail:input.poDetail,priorInvoices:input.priorInvoices,historyComplete:input.invoiceHistoryComplete,catalogMatches:matches});
 if(proposal.state!=='review_required')return stop(proposal.reason);
 const evidence={proposal,quantityEvidence:input.quantityEvidence,poVersion:input.poVersion,historyVersion:input.historyVersion,catalogVersion:input.catalogVersion};
 const revision=prepareInvoiceReviewRevision({...evidence,previous:input.previousRevision??null,expectedRevision:input.expectedRevision,reviewRef:h.reviewRef,recordedAt:input.recordedAt});
 if(revision.state!=='review_required')return stop(revision.reason);
 return {state:'review_required',evidence,revision,receiving:{state:'UNKNOWN',receivedQty:null},executable:false};
 }catch{return stop('malformed_fixture_evidence');}
}

// Not a real authorizer: consumes a synthetic Security verifier, never accepts
// actor roles/grants in payloads. Same underlying operation labels for every origin.
export function createPurchasingReviewFixture({authorize,audit,load,clock=()=>new Date(),maxAgeMs=120000}={}){
 if(typeof authorize!=='function'||typeof audit!=='function'||typeof load!=='function')throw new TypeError('Synthetic adapters required');
 async function check(context,operation,resource,channel){
 let allowed=false;
 try{allowed=(await authorize({context,operation,resource:copy(resource),environment:'test'}))===true;}catch{}
 try{if(await audit({operation,channel,allowed,environment:'test'})!==true)return false;}catch{return false;}
 return allowed;
 }
 return Object.freeze({async run({context,channel,invoiceId,phase}={}){
 if(!channels.has(channel)||!exact(invoiceId)||!['read','review','approve','execute'].includes(phase))return stop('request_invalid');
 // Authorize before loading any sensitive evidence; normal employee read grants
 // include wholesale costs, no separate elevated cost-view grant.
 if(!await check(context,O.read,{invoiceId},channel))return stop('forbidden');
 let input;
 try{input=copy(await load(invoiceId));}catch{return stop('fixture_unavailable');}
 if(input.header?.invoiceId!==invoiceId)return stop('invoice_scope_conflict');
 const result=buildDocumentInvoiceReview(input);
 if(result.state!=='review_required')return result;
 const p=result.evidence.proposal;
 const resource={invoiceId,supplierId:p.supplierId,outletId:p.outletId,targetPoId:p.targetPoId};
 if(phase==='read')return {state:'read_only',lines:p.lines.map(l=>({productId:l.productId,supplierSku:l.supplierSku,invoicedQty:l.invoicedQty,unitCost:l.unitCost,currency:l.currency})),executable:false};
 if(!await check(context,O.review,resource,channel))return stop('forbidden');
 if(phase==='review')return {state:'review_required',revision:result.revision,receiving:result.receiving,executable:false};
 if(!await check(context,O.approve,resource,channel))return stop('forbidden');
 if(phase==='approve')return {state:'synthetic_approval_check_passed',revision:result.revision,executable:false};
 // Re-evaluate all operation decisions at execution, never use a prior grant.
 if(!await check(context,O.execute,resource,channel)||!await check(context,p.mode==='create_open'?O.createPO:O.updatePO,resource,channel))return stop('forbidden');
 for(const l of p.lines){
 if(!await check(context,O.cost,{...resource,productId:l.productId,field:'unitCost'},channel))return stop('forbidden');
 }
 const binding=inspectApprovalBinding({revision:result.revision,approval:input.approval,currentEvidence:result.evidence,now:clock().toISOString(),maxAgeMs});
 if(binding.state!=='binding_matches')return stop('approval_stale');
 // Product creation and supplier-link mutation are intentionally unsupported:
 // no indirect operation can create a product or relationship in this fixture.
 return {state:'synthetic_execution_check_passed',executable:false,productionExecutable:false,receiving:result.receiving};
 }});
}
