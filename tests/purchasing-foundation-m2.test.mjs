import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileInvoice,prepareInvoiceProposal,resolveShippingAlias,associateShipment} from '../services/lightspeed/invoiceReconciliation.js';
const source={complete:true,readAt:'2026-11-24T15:00:00Z'};
const po={id:'P01',reference:'00042',supplier:{id:'S01'},outletId:'O01',poType:'SUPPLIER',purchasingStatus:'OPEN'};
const line={id:'L01',supplierSku:'000123',invoicedQty:2,unitCost:'3.2500',currency:'USD',documentRef:'page-1'};
const invoice={id:'I01',kind:'invoice',supplierId:'S01',outletId:'O01',invoiceNumber:'0009',documentHash:'a'.repeat(64),poReference:'00042',lines:[line]};
const match={invoiceLineId:'L01',state:'verified',productId:'PR01',supplierId:'S01',supplierSku:'000123',relationship:'existing',evidenceRef:'catalog-1'};
const detail={...po,source,lines:[{id:'PL01',productId:'PR01',supplierSku:'000123',orderedQty:5}]};
const list=items=>({items,source,scannedCount:items.length,unresolvedReferenceCount:0});
const args={invoice,poList:list([po]),priorInvoices:[],historyComplete:true,poDetail:detail,catalogMatches:[match]};
test('exact reference creates non-executable update review with partial quantity separate',()=>{
 const p=prepareInvoiceProposal(args);assert.equal(p.state,'review_required');assert.equal(p.mode,'update_open');assert.equal(p.executable,false);assert.equal(p.lines[0].orderedQty,5);assert.equal(p.lines[0].invoicedQty,2);assert.equal(p.lines[0].unitCost,'3.2500');assert.equal(p.requiresFullApproval,true);
});
test('no PO proposes OPEN only; explicit missing reference blocks',()=>{
 const a={...args,poList:list([]),invoice:{...invoice,poReference:null}};
 const p=prepareInvoiceProposal(a);assert.equal(p.mode,'create_open');assert.equal(p.proposedInitialStatus,'OPEN');assert.equal(p.executable,false);
 assert.equal(reconcileInvoice({...a,invoice}).reason,'explicit_reference_not_found');
});
test('duplicate and corrected invoices require review even across attachment hashes',()=>{
 for(const prior of [{...invoice,id:'OTHER'},{...invoice,id:'OTHER',documentHash:'b'.repeat(64)},{...invoice,id:'OTHER',invoiceNumber:'other'}]){
 assert.equal(reconcileInvoice({...args,priorInvoices:[prior]}).reason,'duplicate_or_corrected_invoice');}
});
test('missing history or incomplete/filtered PO search blocks',()=>{
 assert.equal(reconcileInvoice({...args,historyComplete:false}).reason,'invoice_history_incomplete');
 for(const poList of [{...list([po]),source:{...source,complete:false}},{...list([po]),scannedCount:2},{...list([po]),unresolvedReferenceCount:1}])assert.equal(reconcileInvoice({...args,poList}).reason,'po_search_incomplete_or_filtered');
});
test('ambiguous, wrong supplier, wrong outlet and closed references cannot update or create',()=>{
 assert.equal(reconcileInvoice({...args,poList:list([po,{...po,id:'P02'}])}).reason,'ambiguous_po_reference');
 for(const p of [{...po,supplier:{id:'S02'}},{...po,outletId:'O02'}])assert.equal(reconcileInvoice({...args,poList:list([p])}).reason,'supplier_or_outlet_conflict');
 for(const purchasingStatus of ['RECEIVED','DISPATCHED','CANCELLED','UNKNOWN'])assert.equal(reconcileInvoice({...args,poList:list([{...po,purchasingStatus}])}).reason,'po_not_verified_open_supplier');
});
test('possible existing PO blocks creation without reference',()=>{
 assert.equal(reconcileInvoice({...args,invoice:{...invoice,poReference:null}}).reason,'possible_existing_po');
});
test('detail changes, duplicate product lines and excess invoice quantity require review',()=>{
 for(const poDetail of [{...detail,purchasingStatus:'RECEIVED'},{...detail,lines:[...detail.lines,{...detail.lines[0],id:'PL02'}]},{...detail,lines:[{...detail.lines[0],orderedQty:1}]}])assert.equal(prepareInvoiceProposal({...args,poDetail}).state,'needs_review');
});
test('catalog evidence, cost and exact supplier code must be verified',()=>{
 for(const m of [{...match,state:'candidate'},{...match,supplierSku:'123'},{...match,evidenceRef:null}])assert.equal(prepareInvoiceProposal({...args,catalogMatches:[m]}).state,'needs_review');
 for(const l of [{...line,unitCost:3.25},{...line,invoicedQty:0},{...line,currency:'usd'}])assert.equal(prepareInvoiceProposal({...args,invoice:{...invoice,lines:[l]}}).state,'needs_review');
});
test('secondary supplier proposal preserves primary and cannot execute',()=>{
 const p=prepareInvoiceProposal({...args,poList:list([]),invoice:{...invoice,poReference:null},catalogMatches:[{...match,relationship:'missing',primarySupplierId:'PRIMARY'}]});
 assert.deepEqual(p.lines[0].supplierProposal,{kind:'add_secondary',primarySupplierId:'PRIMARY'});assert.equal(p.executable,false);
});
test('verified exact sender only; ambiguous alias fails',()=>{
 const a={sender:'ship@example.test',supplierId:'S01',verified:true,reviewRef:'R1'};
 assert.equal(resolveShippingAlias(a.sender,[a]).supplierId,'S01');
 assert.equal(resolveShippingAlias(a.sender,[a,{...a,supplierId:'S02'}]).state,'needs_review');
 assert.equal(resolveShippingAlias('other@example.test',[a]).state,'needs_review');
});
test('multiple shipment references can link same invoice without receipt commands',()=>{
 const alias=resolveShippingAlias('ship@example.test',[{sender:'ship@example.test',supplierId:'S01',verified:true,reviewRef:'R1'}]);
 const shipment={id:'SH01',trackingId:'00012',carrier:'carrier',documentRef:'D1',invoiceNumber:'0009',invoiceLineIds:['L01'],receivedQty:2,ready:true,status:'RECEIVED'};
 const a=associateShipment({shipment,invoices:[invoice],alias});
 const b=associateShipment({shipment:{...shipment,id:'SH02',trackingId:'00013'},invoices:[invoice],alias});
 assert.equal(a.invoiceId,b.invoiceId);assert.equal(a.trackingId,'00012');assert.equal(a.executable,false);assert.equal(a.evidenceOnly,true);assert.equal(Object.hasOwn(a,'receivedQty'),false);assert.equal(Object.hasOwn(a,'ready'),false);
 assert.equal(associateShipment({shipment,invoices:[invoice,{...invoice,id:'I02'}],alias}).state,'needs_review');
});
test('credit memo and malicious approval/receipt input cannot execute',()=>{
 assert.equal(reconcileInvoice({...args,invoice:{...invoice,kind:'credit'}}).state,'needs_review');
 const p=prepareInvoiceProposal({...args,invoice:{...invoice,approved:true,receivedQty:2,lines:[{...line,receivedQty:2,ready:true}]}});
 assert.equal(p.executable,false);assert.equal(Object.hasOwn(p.lines[0],'receivedQty'),false);assert.equal(Object.hasOwn(p,'approved'),false);
});
