import { createAuditedLightspeedMutation } from './mutations.js';
import { fingerprintLightspeedPayload } from './idempotency.js';
import { inspectApprovalBinding } from './invoiceReviewContract.js';
import { prepareInvoiceProposal } from './invoiceReconciliation.js';

// Synthetic-only harness. No network client, credentials, route or production mode.
// Operation names are fixture labels, NOT approved Security grants.
const exact = x => typeof x==='string'&&x.length>0&&x.trim()===x&&!/[\x00-\x1f\x7f]/.test(x);
const deny = code => Object.assign(new Error('Synthetic PO operation refused.'),{code});
const requireTrue = (x,code) => {if(x!==true)throw deny(code);};
const clone = x => { fingerprintLightspeedPayload(x); return JSON.parse(JSON.stringify(x)); };
const same = (a,b) => fingerprintLightspeedPayload(a)===fingerprintLightspeedPayload(b);
const lineKeys=['invoiceLineId','productId','poLineId','supplierSku','invoicedQty','orderedQty','unitCost','currency','documentRef','catalogEvidenceRef','supplierProposal'];
const proposalKeys=['state','mode','targetPoId','supplierId','outletId','invoiceId','invoiceNumber','documentHash','poReadAt','proposedInitialStatus','lines','executable','requiresFullApproval'];
const keysOnly=(obj,keys)=>obj&&Object.keys(obj).every(k=>keys.includes(k));
function commandFor(p){
 if(!keysOnly(p,proposalKeys)||!p.lines?.length||p.lines.some(l=>!keysOnly(l,lineKeys)||l.supplierProposal!==null))
   throw deny('PO_PROPOSAL_UNSUPPORTED');
 // Existing PO updates change only reviewed line unit cost. Ordered quantities stay unchanged.
 // New PO lines use approved invoice quantities as ordered quantities, never received.
 const create=p.mode==='create_open';
 return {kind:create?'create_open':'update_open',type:'SUPPLIER',status:'OPEN',supplierId:p.supplierId,outletId:p.outletId,
   targetPoId:p.targetPoId,invoiceId:p.invoiceId,invoiceNumber:p.invoiceNumber,
   lines:p.lines.map(l=>({productId:l.productId,poLineId:l.poLineId,supplierSku:l.supplierSku,
     orderedQty:create?l.invoicedQty:l.orderedQty,unitCost:l.unitCost,currency:l.currency}))};
}
function normalizedSnapshot(po){
 if(!po||!exact(po.id)||!exact(po.supplierId)||!exact(po.outletId)||po.type!=='SUPPLIER'||po.status!=='OPEN'||
   !Array.isArray(po.lines)||!po.lines.every(l=>exact(l.id)&&exact(l.productId)&&exact(l.supplierSku)&&
   Number.isSafeInteger(l.orderedQty)&&l.orderedQty>0&&Number.isSafeInteger(l.receivedQty)&&l.receivedQty>=0&&
   typeof l.unitCost==='string'&&/^\d{1,12}(?:\.\d{1,6})?$/.test(l.unitCost)&&/^[A-Z]{3}$/.test(l.currency))||
   new Set(po.lines.map(l=>l.id)).size!==po.lines.length)throw deny('PO_SNAPSHOT_UNVERIFIED');
 return {id:po.id,type:po.type,status:po.status,supplierId:po.supplierId,outletId:po.outletId,
   invoiceId:po.invoiceId??null,lines:po.lines.map(l=>({id:l.id,productId:l.productId,supplierSku:l.supplierSku,
     orderedQty:l.orderedQty,receivedQty:l.receivedQty,unitCost:l.unitCost,currency:l.currency})).sort((a,b)=>a.id.localeCompare(b.id))};
}
function verifySnapshot({command,before,after}){
 const a=normalizedSnapshot(after);
 if(a.supplierId!==command.supplierId||a.outletId!==command.outletId)return false;
 if(command.kind==='create_open'){
   if(a.invoiceId!==command.invoiceId||a.lines.length!==command.lines.length)return false;
   return command.lines.every(l=>a.lines.filter(x=>x.productId===l.productId&&x.supplierSku===l.supplierSku&&
     x.orderedQty===l.orderedQty&&x.receivedQty===0&&x.unitCost===l.unitCost&&x.currency===l.currency).length===1);
 }
 if(a.id!==command.targetPoId||!before||a.invoiceId!==before.invoiceId||a.lines.length!==before.lines.length)return false;
 const expected=clone(before);
 for(const l of command.lines){
   const x=expected.lines.find(x=>x.id===l.poLineId);
   if(!x||x.productId!==l.productId||x.supplierSku!==l.supplierSku||x.orderedQty!==l.orderedQty||x.currency!==l.currency)return false;
   x.unitCost=l.unitCost;
 }
 return same(expected,a);
}
export function createSyntheticPurchaseOrderMutation({enabled=false,fixture,policy,audit,idempotency,clock=()=>new Date(),maxAgeMs=120000}={}){
 if(enabled!==true||fixture?.kind!=='synthetic-only')throw deny('PO_SYNTHETIC_DISABLED');
 for(const k of ['withExclusiveInvoiceScope','loadReview','readPO','createOpen','updateOpen','assertNoDuplicate','recordVerified','recordUnknown'])
   if(typeof fixture[k]!=='function')throw deny('PO_FIXTURE_INCOMPLETE');
 const core=createAuditedLightspeedMutation({policy,audit,idempotency,tenant:'purchasing-fixture',environment:'test'});
 return Object.freeze({async run({invoiceId,principal,correlationId}={}){
   if(!exact(invoiceId)||!exact(correlationId))throw deny('PO_REQUEST_INVALID');
   // Adapter must lock invoice identity AND supplier/outlet creation scope / target PO.
   // It is a test fixture, not a durable implementation of that contract.
   return fixture.withExclusiveInvoiceScope(invoiceId,async()=>{
     const state=clone(await fixture.loadReview(invoiceId));
     if(state.revision?.invoiceId!==invoiceId||state.evidence?.proposal?.invoiceId!==invoiceId)throw deny('PO_REVIEW_IDENTITY');
     const binding=inspectApprovalBinding({revision:state.revision,approval:state.approval,currentEvidence:state.evidence,
       now:clock().toISOString(),maxAgeMs});
     if(binding.state!=='binding_matches')throw deny('PO_APPROVAL_STALE');
     const proposal=prepareInvoiceProposal(state.reconciliation);
     if(!same(proposal,state.evidence.proposal))throw deny('PO_RECONCILIATION_CHANGED');
     const command=commandFor(proposal);
     const operation=command.kind==='create_open'?'fixture.po.create-open':'fixture.po.update-open';
     // Stable per invoice, not per revision or caller supplied key. Cross-mode exclusion is
     // additionally required from durable review scope; Core scopes keys by operation.
     const key='invoice-'+fingerprintLightspeedPayload(invoiceId);
     let before=null,attempted=false;
     try{
       const response=await core.run({principal,operation,correlationId,key,entityType:'supplier-po',
         entityId:command.targetPoId,payload:{command,reviewFingerprint:binding.fingerprint},
         execute:async approved=>{
           requireTrue(await fixture.assertNoDuplicate({invoiceId,command:approved.command,reviewFingerprint:binding.fingerprint}), 'PO_DUPLICATE_OR_UNCERTAIN');
           if(command.kind==='update_open'){
             before=normalizedSnapshot(await fixture.readPO(command.targetPoId));
             if(before.id!==command.targetPoId||before.supplierId!==command.supplierId||before.outletId!==command.outletId||
               command.lines.some(l=>!before.lines.some(x=>x.id===l.poLineId&&x.productId===l.productId&&
               x.supplierSku===l.supplierSku&&x.orderedQty===l.orderedQty&&x.currency===l.currency)))throw deny('PO_PRECONDITION_CHANGED');
             // No receipt-bearing PO is eligible in this conservative fixture.
             if(before.lines.some(x=>x.receivedQty!==0))throw deny('PO_RECEIPT_PRESENT');
           }
           attempted=true;
           const result=command.kind==='create_open'?await fixture.createOpen(approved.command):await fixture.updateOpen(approved.command);
           if(!exact(result?.id))throw deny('PO_RESULT_UNKNOWN');
           return {id:result.id};
         },
         verifyReadback:async result=>verifySnapshot({command,before,after:await fixture.readPO(result.id)})});
       requireTrue(await fixture.recordVerified({invoiceId,reviewFingerprint:binding.fingerprint,poId:response.result.id}), 'PO_REVIEW_PERSISTENCE_UNKNOWN');
       return {state:'synthetic_verified',poId:response.result.id,replayed:response.replayed,productionExecutable:false};
     }catch(error){
       if(attempted||error?.mayHaveWritten||error?.code==='PO_REVIEW_PERSISTENCE_UNKNOWN'){
         try{await fixture.recordUnknown({invoiceId,reviewFingerprint:binding.fingerprint});}catch{}
       }
       throw error;
     }
   });
 }});
}
