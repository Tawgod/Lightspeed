// P-02: offline review candidates only. No I/O, authorization, inventory or writer.
const exact = v => typeof v === 'string' && v.length > 0 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const review = (reason, candidateIds = []) => ({state:'needs_review',reason,candidateIds,executable:false});
const validQty = v => Number.isSafeInteger(v) && v > 0;
const validCost = v => typeof v === 'string' && /^\d{1,12}(?:\.\d{1,6})?$/.test(v);
const identity = x => x && exact(x.id);
const unique = rows => Array.isArray(rows) && rows.every(identity) && new Set(rows.map(r=>r.id)).size === rows.length;
const sourceComplete = x => x?.source?.complete === true && Number.isFinite(Date.parse(x.source.readAt));
export function resolveShippingAlias(sender, aliases) {
  if (!exact(sender) || !Array.isArray(aliases)) return review('alias_evidence_unavailable');
  // Exact reviewed sender keys only; no domain inference or automatic alias creation.
  const matches = aliases.filter(a=>a?.sender === sender);
  if (matches.length !== 1 || matches[0].verified !== true ||
      !exact(matches[0].supplierId) || !exact(matches[0].reviewRef)) return review('alias_unverified_or_ambiguous');
  return {state:'candidate',supplierId:matches[0].supplierId,reviewRef:matches[0].reviewRef,executable:false};
}
export function reconcileInvoice({invoice, poList, priorInvoices, historyComplete=false}={}) {
  if (!identity(invoice) || !exact(invoice.supplierId) || !exact(invoice.outletId) ||
      !exact(invoice.invoiceNumber) || !hash(invoice.documentHash) || invoice.kind !== 'invoice' ||
      !unique(invoice.lines) || !invoice.lines.length) return review('invoice_identity_or_lines_unresolved');
  if (historyComplete !== true || !unique(priorInvoices) || priorInvoices.some(x=>!exact(x.supplierId)||!exact(x.invoiceNumber)||!hash(x.documentHash)))
    return review('invoice_history_incomplete');
  const duplicate = priorInvoices.filter(x=>x.id===invoice.id || x.documentHash===invoice.documentHash ||
    (x.supplierId===invoice.supplierId && x.invoiceNumber===invoice.invoiceNumber));
  if (duplicate.length) return review('duplicate_or_corrected_invoice',duplicate.map(x=>x.id));
  if (!sourceComplete(poList) || !unique(poList.items) || poList.unresolvedReferenceCount !== 0 ||
      poList.scannedCount !== poList.items.length) return review('po_search_incomplete_or_filtered');
  if (invoice.poReference != null && !exact(invoice.poReference)) return review('invalid_po_reference');
  const rows=poList.items;
  if (rows.some(p=>!exact(p.supplier?.id)||!exact(p.outletId))) return review('unresolved_po_references');
  const supplierRows=rows.filter(p=>p.supplier.id===invoice.supplierId && p.outletId===invoice.outletId);
  const ref=invoice.poReference;
  const explicit=ref==null?[]:rows.filter(p=>p.id===ref||p.reference===ref);
  if (explicit.length>1) return review('ambiguous_po_reference',explicit.map(p=>p.id));
  if (explicit.length===1 && !supplierRows.includes(explicit[0])) return review('supplier_or_outlet_conflict',explicit.map(p=>p.id));
  const compatible=supplierRows.filter(p=>!['CLOSED','CANCELLED','RECEIVED'].includes(p.purchasingStatus));
  if (explicit.length===1) {
    const p=explicit[0];
    if (p.purchasingStatus!=='OPEN'||p.poType!=='SUPPLIER') return review('po_not_verified_open_supplier',[p.id]);
    return {state:'candidate',mode:'update_open',targetPoId:p.id,executable:false};
  }
  // No fuzzy auto-link or create if any plausible PO remains, including unknown status.
  if (compatible.length) return review('possible_existing_po',compatible.map(p=>p.id));
  if (ref!=null) return review('explicit_reference_not_found');
  // Closed history does not establish absence of duplicate invoice: prior history gate above.
  return {state:'candidate',mode:'create_open',targetPoId:null,executable:false};
}
export function prepareInvoiceProposal({invoice,poList,priorInvoices,historyComplete,poDetail,catalogMatches}={}) {
  const association=reconcileInvoice({invoice,poList,priorInvoices,historyComplete});
  if (association.state!=='candidate') return association;
  if (!Array.isArray(catalogMatches)) return review('catalog_evidence_missing');
  const updating=association.mode==='update_open';
  if (updating && (!sourceComplete(poDetail)||poDetail.id!==association.targetPoId||
    poDetail.supplier?.id!==invoice.supplierId||poDetail.outletId!==invoice.outletId||
    poDetail.poType!=='SUPPLIER'||poDetail.purchasingStatus!=='OPEN'||!unique(poDetail.lines)))
    return review('po_detail_unresolved_or_changed',[association.targetPoId]);
  const lines=[];
  for(const line of invoice.lines){
    const matches=catalogMatches.filter(m=>m?.invoiceLineId===line.id);
    if(matches.length!==1||matches[0].state!=='verified'||!exact(matches[0].productId)||
       !exact(matches[0].evidenceRef)||matches[0].supplierId!==invoice.supplierId||
       !validQty(line.invoicedQty)||!validCost(line.unitCost)||!exact(line.documentRef)||
       !/^[A-Z]{3}$/.test(line.currency||'')||!exact(line.supplierSku))return review('invoice_line_needs_review');
    const m=matches[0];
    if(m.supplierSku!==line.supplierSku) return review('supplier_sku_conflict');
    const candidates=updating?poDetail.lines.filter(p=>p.productId===m.productId):[];
    if(updating&&(candidates.length!==1||!validQty(candidates[0].orderedQty)||
      candidates[0].orderedQty<line.invoicedQty||candidates[0].supplierSku!==line.supplierSku))
      return review('po_line_or_quantity_conflict',[association.targetPoId]);
    if(lines.some(p=>p.productId===m.productId)) return review('duplicate_product_lines_require_review');
    if(m.relationship!=='existing'&&m.relationship!=='missing')return review('supplier_relationship_unresolved');
    if(m.relationship==='missing'&&!exact(m.primarySupplierId))return review('primary_supplier_unresolved');
    lines.push({invoiceLineId:line.id,productId:m.productId,poLineId:candidates[0]?.id??null,
      supplierSku:line.supplierSku,invoicedQty:line.invoicedQty,orderedQty:candidates[0]?.orderedQty??null,
      unitCost:line.unitCost,currency:line.currency,documentRef:line.documentRef,catalogEvidenceRef:m.evidenceRef,
      supplierProposal:m.relationship==='missing'?{kind:'add_secondary',primarySupplierId:m.primarySupplierId}:null});
  }
  if(new Set(lines.map(l=>l.currency)).size!==1)return review('mixed_currency_invoice');
  return {state:'review_required',mode:association.mode,targetPoId:association.targetPoId,
    supplierId:invoice.supplierId,outletId:invoice.outletId,invoiceId:invoice.id,invoiceNumber:invoice.invoiceNumber,
    documentHash:invoice.documentHash,poReadAt:updating?poDetail.source.readAt:poList.source.readAt,
    proposedInitialStatus:updating?null:'OPEN',lines,executable:false,requiresFullApproval:true};
}
export function associateShipment({shipment, invoices, alias}={}) {
  if(!identity(shipment)||!exact(shipment.trackingId)||!exact(shipment.carrier)||!exact(shipment.documentRef)||
    !unique(invoices)||alias?.state!=='candidate'||!exact(alias.supplierId)||!exact(alias.reviewRef)||
    !exact(shipment.invoiceNumber))return review('shipment_evidence_unresolved');
  const matches=invoices.filter(i=>i.supplierId===alias.supplierId&&i.invoiceNumber===shipment.invoiceNumber);
  if(matches.length!==1)return review('shipment_invoice_ambiguous',matches.map(i=>i.id));
  const invoice=matches[0];
  if(!unique(invoice.lines)||!Array.isArray(shipment.invoiceLineIds)||!shipment.invoiceLineIds.length||
     new Set(shipment.invoiceLineIds).size!==shipment.invoiceLineIds.length||
     shipment.invoiceLineIds.some(id=>!invoice.lines.some(l=>l.id===id)))return review('shipment_lines_unresolved');
  return {state:'candidate',shipmentId:shipment.id,trackingId:shipment.trackingId,carrier:shipment.carrier,
    invoiceId:invoice.id,supplierId:alias.supplierId,invoiceLineIds:[...shipment.invoiceLineIds],
    documentRef:shipment.documentRef,aliasReviewRef:alias.reviewRef,evidenceOnly:true,executable:false};
}
