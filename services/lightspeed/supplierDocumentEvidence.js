import { createHash } from 'node:crypto';
import { resolveSupplierIdentity, inspectSupplierProductLinks } from './catalog.js';

// Internal offline evidence contract. No provider SDK, network, parser or storage access.
// Metadata and scan assertions must eventually originate in trusted server adapters.
const exact = v => typeof v==='string'&&v.length>0&&v.length<=512&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const hash = v => typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const instant = v => typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const review = reason => ({state:'needs_review',reason,evidenceOnly:true,executable:false});
const kinds = new Set(['invoice','credit_note','preorder_confirmation','shipping_notice','unknown']);
const key = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const MAX_BYTES=20*1024*1024;
export function projectSupplierDocument({source,attachment,extraction}={}){
 if(!source||!['gmail','graph','vendor','manual'].includes(source.provider)||
   !exact(source.accountRef)||!exact(source.messageId)||!exact(source.senderKey)||!instant(source.observedAt))
   return review('source_identity_unresolved');
 if(!attachment||!exact(attachment.id)||attachment.mime!=='application/pdf'||
   !Number.isSafeInteger(attachment.byteLength)||attachment.byteLength<1||attachment.byteLength>MAX_BYTES||
   !hash(attachment.sha256)||attachment.scanState!=='clean'||!exact(attachment.scanRef))
   return review('attachment_unverified_or_unsupported');
 if(!extraction||extraction.documentHash!==attachment.sha256||!kinds.has(extraction.kind)||
   !exact(extraction.parserVersion)||!Array.isArray(extraction.lines)||extraction.lines.length>500||
   !Array.isArray(extraction.references)||extraction.references.length>100||
   extraction.references.some(r=>!exact(r))||
   new Set(extraction.lines.map(l=>l?.id)).size!==extraction.lines.length)
   return review('extraction_unresolved');
 const lines=[];
 for(const l of extraction.lines){
   if(!exact(l?.id)||!Number.isSafeInteger(l.page)||l.page<1||
      !exact(l.documentRef)||!(l.supplierSku===null||exact(l.supplierSku))||
      !(l.quantity===null||(typeof l.quantity==='string'&&/^-?\d{1,12}(?:\.\d{1,6})?$/.test(l.quantity)))||
      !(l.unitCost===null||(typeof l.unitCost==='string'&&/^-?\d{1,12}(?:\.\d{1,6})?$/.test(l.unitCost)))||
      !(l.currency===null||(typeof l.currency==='string'&&/^[A-Z]{3}$/.test(l.currency))))return review('line_evidence_unresolved');
   lines.push({id:l.id,page:l.page,documentRef:l.documentRef,supplierSku:l.supplierSku,
     quantity:l.quantity,unitCost:l.unitCost,currency:l.currency});
 }
 return {state:'staged_evidence',evidenceOnly:true,executable:false,
   sourceKey:key([source.provider,source.accountRef,source.messageId,attachment.id]),
   documentHash:attachment.sha256,source:{provider:source.provider,accountRef:source.accountRef,messageId:source.messageId,
     senderKey:source.senderKey,observedAt:source.observedAt},attachmentId:attachment.id,scanRef:attachment.scanRef,
   kind:extraction.kind,parserVersion:extraction.parserVersion,
   references:[...extraction.references],lines,requiresReview:true};
}
export function inspectDocumentReplay(document,prior,{complete=false}={}){
 if(document?.state!=='staged_evidence'||!hash(document.sourceKey)||!hash(document.documentHash)||
   complete!==true||!Array.isArray(prior)||prior.some(p=>!hash(p?.sourceKey)||!hash(p.documentHash)))
   return review('document_history_unresolved');
 const sameSource=prior.filter(p=>p.sourceKey===document.sourceKey);
 if(sameSource.some(p=>p.documentHash!==document.documentHash))return review('source_content_conflict');
 if(sameSource.length||prior.some(p=>p.documentHash===document.documentHash))
   return {state:'duplicate_candidate',reason:'source_or_content_seen',evidenceOnly:true,executable:false};
 return {state:'new_candidate',evidenceOnly:true,executable:false};
}
export function resolveDocumentSupplier({document,aliasRows,complete=false}={}){
 if(document?.state!=='staged_evidence'||!exact(document.source?.senderKey))return review('document_unresolved');
 // Source is a dedicated mail/vendor sender namespace; never infer from a domain.
 const source='purchasing:'+document.source.provider+':'+document.source.accountRef;
 if(source.length>512)return review('supplier_alias_unresolved');
 let result;
 try{result=resolveSupplierIdentity({source,alias:document.source.senderKey},aliasRows,{complete});}
 catch{return review('supplier_alias_unresolved');}
 if(result.status!=='EXACT_UNIQUE'||result.complete!==true||result.candidates.length!==1)
   return review('supplier_alias_unresolved');
 return {state:'candidate',supplierId:result.candidates[0].supplierId,evidence:result.candidates[0].evidence,
   sourceKey:document.sourceKey,documentHash:document.documentHash,evidenceOnly:true,executable:false};
}
export function inspectInvoiceCatalogLink({supplier,line,target,rows,complete=false}={}){
 if(supplier?.state!=='candidate'||!exact(supplier.supplierId)||!exact(line?.supplierSku)||
   !exact(target?.productId)||!(target.variantId===null||exact(target.variantId)))return review('catalog_scope_unresolved');
 let result;
 try{result=inspectSupplierProductLinks(target,rows,{complete});}
 catch{return review('catalog_link_unresolved');}
 if(result.complete!==true)return review('catalog_link_unresolved');
 const link=result.links.find(r=>r.supplierId===supplier.supplierId);
 if(!link||link.supplierSku!==line.supplierSku||link.primary===null||
   link.observations.some(o=>o.supplierSku===null||o.primary===null))
   return review('catalog_link_missing_or_conflicting');
 // Candidate only, not P-02 verified-match authority; product identity and variant
 // selection require separately accepted catalog evidence.
 return {state:'candidate',productId:target.productId,variantId:target.variantId,supplierId:supplier.supplierId,
   supplierSku:link.supplierSku,primary:link.primary,evidence:link.observations,evidenceOnly:true,executable:false};
}
