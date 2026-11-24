import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSupplierDocument,inspectDocumentReplay,resolveDocumentSupplier,inspectInvoiceCatalogLink} from '../services/lightspeed/supplierDocumentEvidence.js';
const at='2026-11-24T15:00:00.000Z', sha='a'.repeat(64);
const source={provider:'graph',accountRef:'store-mail',messageId:'M1',senderKey:'ship@example.test',observedAt:at};
const attachment={id:'A1',mime:'application/pdf',byteLength:123,sha256:sha,scanState:'clean',scanRef:'scan-1'};
const line={id:'L1',page:1,documentRef:'page-1',supplierSku:'000123',quantity:'2',unitCost:'3.2500',currency:'USD'};
const extraction={documentHash:sha,kind:'invoice',parserVersion:'fixture-v1',references:['00042'],lines:[line]};
const input={source,attachment,extraction};
const document=projectSupplierDocument(input);
const alias={source:'purchasing:graph:store-mail',alias:source.senderKey,supplierId:'S1',verified:true,provenance:'review-1',observedAt:at};
const supplier=resolveDocumentSupplier({document,aliasRows:[alias],complete:true});
const target={productId:'P1',variantId:null};
const link={...target,supplierId:'S1',supplierSku:'000123',primary:false,source:'catalog',provenance:'mapping-1',observedAt:at};
test('provider-neutral document preserves source IDs, hash, decimal text, leading zeros and page provenance',()=>{
 assert.equal(document.state,'staged_evidence');assert.equal(document.lines[0].supplierSku,'000123');assert.equal(document.lines[0].unitCost,'3.2500');assert.equal(document.documentHash,sha);assert.equal(document.lines[0].page,1);assert.equal(document.executable,false);
 for(const provider of ['gmail','vendor','manual'])assert.notEqual(projectSupplierDocument({...input,source:{...source,provider}}).sourceKey,document.sourceKey);
});
test('untrusted or oversized attachment and incorrect extraction hash rejected',()=>{
 for(const a of [{...attachment,scanState:'pending'},{...attachment,mime:'text/html'},{...attachment,byteLength:21*1024*1024},{...attachment,scanRef:null}])assert.equal(projectSupplierDocument({...input,attachment:a}).state,'needs_review');
 assert.equal(projectSupplierDocument({...input,extraction:{...extraction,documentHash:'b'.repeat(64)}}).state,'needs_review');
});
test('unsupported or malformed lines fail closed, missing values remain unknown',()=>{
 for(const l of [{...line,supplierSku:123},{...line,page:0},{...line,quantity:2},{...line,currency:'usd'}])assert.equal(projectSupplierDocument({...input,extraction:{...extraction,lines:[l]}}).state,'needs_review');
 assert.equal(projectSupplierDocument({...input,extraction:{...extraction,lines:[line,line]}}).state,'needs_review');
 const d=projectSupplierDocument({...input,extraction:{...extraction,lines:[{...line,quantity:null,unitCost:null,currency:null}]}});
 assert.equal(d.lines[0].quantity,null);
});
test('replay detection separates exact source, forwarded content and source hash conflicts',()=>{
 assert.equal(inspectDocumentReplay(document,[],{complete:true}).state,'new_candidate');
 assert.equal(inspectDocumentReplay(document,[document],{complete:true}).state,'duplicate_candidate');
 assert.equal(inspectDocumentReplay(document,[{...document,sourceKey:'b'.repeat(64)}],{complete:true}).state,'duplicate_candidate');
 assert.equal(inspectDocumentReplay(document,[{...document,documentHash:'b'.repeat(64)}],{complete:true}).reason,'source_content_conflict');
 assert.equal(inspectDocumentReplay(document,[]).state,'needs_review');
});
test('canonical supplier resolver requires exact source scoped verified unique alias',()=>{
 assert.equal(supplier.supplierId,'S1');assert.equal(supplier.executable,false);
 for(const rows of [[{...alias,source:'purchasing:gmail:store-mail'}],[{...alias,verified:false}],[alias,{...alias,supplierId:'S2'}],[{...alias,alias:'example.test'}]])assert.equal(resolveDocumentSupplier({document,aliasRows:rows,complete:true}).state,'needs_review');
 assert.equal(resolveDocumentSupplier({document,aliasRows:[alias]}).state,'needs_review');
});
test('catalog link uses exact supplier SKU and explicit variant scope, no automatic promotion',()=>{
 const r=inspectInvoiceCatalogLink({supplier,line,target,rows:[link],complete:true});
 assert.equal(r.state,'candidate');assert.equal(r.primary,false);assert.equal(r.executable,false);
 for(const rows of [[{...link,supplierSku:'123'}],[{...link,variantId:'V1'}],[link,{...link,supplierSku:'DIFFERENT'}],[{...link,primary:null}]])assert.equal(inspectInvoiceCatalogLink({supplier,line,target,rows,complete:true}).state,'needs_review');
});
test('shipping, credit and preorder documents stay documentary only; untrusted commands removed',()=>{
 for(const kind of ['shipping_notice','credit_note','preorder_confirmation','unknown']){
 const d=projectSupplierDocument({...input,extraction:{...extraction,kind,approved:true,receivedQty:5,ready:true,lines:[{...line,receivedQty:5,inventoryDelta:5}]}});
 assert.equal(d.kind,kind);assert.equal(d.executable,false);assert.equal(Object.hasOwn(d,'approved'),false);assert.equal(Object.hasOwn(d.lines[0],'receivedQty'),false);assert.equal(Object.hasOwn(d.lines[0],'inventoryDelta'),false);}
});
