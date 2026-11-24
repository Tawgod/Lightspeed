import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatalogShadowRead,compareProductManagerShadow,projectPurchasingSupplierEvidence} from '../services/lightspeed/productCatalogShadow.js';
import {prepareInvoiceProposal} from '../services/lightspeed/invoiceReconciliation.js';
const target={productId:'a',variantId:null}, ev={source:'fixture',provenance:'private-provenance',observedAt:'2026-11-24T10:00:00.000Z'};
const kinds=['suppliers','brands','manufacturers','departments','categories','tags'];
const refs=()=>Object.fromEntries(kinds.map(k=>[k,[]]));
const code=(kind,exactValue,extra={})=>({...ev,kind,exactValue,...extra});
const fixture=()=>{
 const referenceIds=refs();referenceIds.suppliers=['001'];
 const references=refs();references.suppliers=[{...ev,id:'001',name:'Supplier'}];
 return {identity:[{...target,name:'Example Model Kit',active:true,referenceIds,identifiers:[code('SKU','00012345'),code('UPC','012345678905'),code('SUPPLIER_SKU','0007',{supplierId:'001'})],raw:{customerEmail:'private-email'}}],
 supplierLinks:[{...target,...ev,supplierId:'001',supplierSku:'0007',primary:true}],
 prices:[{...target,...ev,kind:'RETAIL',amount:'39.99',currency:'USD',supplierId:null,outletId:null},{...target,...ev,kind:'COST',amount:'17.123456',currency:'USD',supplierId:'001',outletId:null}],
 references,assets:[{...target,...ev,assetId:'A',kind:'IMAGE',role:'PRIMARY',slot:0,availability:'AVAILABLE',reference:{kind:'STORAGE_ID',value:'private-storage'}}],
 coverage:{identity:true,supplierLinks:true,prices:true,references:true,assets:true}};
};
const sample={id:'a',sku:'00012345',upc:'012345678905',name:'Example Model Kit',price:39.99,itemOnline:false,active:true,description:'Scale model kit'};
const read=(f=fixture(),grant=({operation})=>operation==='catalog.product.read')=>createCatalogShadowRead({authorizeRead:grant,readSnapshot:async()=>f})({target,context:{fixture:true}});
test('core envelope exact admission and correlation before snapshot read',async()=>{
 const events=[];
 const r=await createCatalogShadowRead({authorizeRead:async a=>{events.push(a);return a.operation==='catalog.product.read';},readSnapshot:async a=>{events.push(a);return fixture();}})({target});
 assert.equal(r.status,200);assert.equal(r.body.version,'core.v1');assert.equal(r.body.readOnly,true);
 assert.equal(events.length,2);assert.ok(events.every(e=>e.correlationId===r.body.correlationId));assert.equal(events[0].environment,'test');
});
test('deny or truthy grant never reads snapshot',async()=>{
 for(const grant of [false,{granted:true},null]){
  let calls=0;const r=await createCatalogShadowRead({authorizeRead:async()=>grant,readSnapshot:async()=>{calls++;return fixture();}})({target});
  assert.equal(r.status,403);assert.equal(calls,0);
 }
});
test('ordinary catalog read includes costs but excludes private evidence and supplier codes',async()=>{
 const r=await read();const s=JSON.stringify(r.body.data);
 for(const value of ['private-email','private-provenance','private-storage','0007','diagnostics'])assert.equal(s.includes(value),false);
 assert.equal(r.body.data.product.identifiers[0].exactValue,'00012345');assert.equal(r.body.data.costs[0].amount,'17.123456');
});
test('ordinary employee read needs no elevated cost grant; incomplete costs remain null',async()=>{
 const calls=[];const r=await read(fixture(),({operation})=>{calls.push(operation);return operation==='catalog.product.read';});
 assert.equal(r.body.data.costs[0].amount,'17.123456');assert.deepEqual(calls,['catalog.product.read']);
 const f=fixture();f.coverage.prices=false;assert.equal((await read(f)).body.data.costs,null);
});
test('actual PR28 sample fields compare without claiming full parity',async()=>{
 const r=compareProductManagerShadow(sample,(await read()).body.data);
 assert.equal(r.state,'partial_parity');assert.deepEqual(r.differences,[]);assert.ok(r.gaps.includes('itemOnline'));assert.equal(r.activationReady,false);
});
test('shadow detects price and exact identifier differences without rounding',async()=>{
 const f=fixture();f.prices[0].amount='39.9901';
 const r=compareProductManagerShadow({...sample,sku:'12345'},(await read(f)).body.data);
 assert.ok(r.differences.includes('SKU'));assert.ok(r.gaps.includes('RETAIL_COVERAGE'));
});
test('Purchasing exact supplier mapping is compatible with current proposal contract',()=>{
 const f=fixture(),m=projectPurchasingSupplierEvidence({invoiceLineId:'L1',supplierId:'001',supplierSku:'0007',identityRows:f.identity,linkRows:f.supplierLinks,identityComplete:true,linksComplete:true,evidenceRef:'evidence-1'});
 assert.equal(m.state,'verified');assert.equal(m.relationship,'existing');assert.equal(m.executable,false);
 const invoice={id:'I1',supplierId:'001',outletId:'O1',invoiceNumber:'INV1',documentHash:'a'.repeat(64),kind:'invoice',lines:[{id:'L1',supplierSku:'0007',invoicedQty:1,unitCost:'17.12',currency:'USD',documentRef:'doc-1'}]};
 const p=prepareInvoiceProposal({invoice,poList:{items:[],unresolvedReferenceCount:0,scannedCount:0,source:{complete:true,readAt:ev.observedAt}},priorInvoices:[],historyComplete:true,catalogMatches:[m]});
 assert.equal(p.state,'review_required');assert.equal(p.executable,false);assert.equal(p.lines[0].supplierProposal,null);
});
test('supplier collision, variant, inactive or absent link require review',()=>{
 const args=f=>({invoiceLineId:'L1',supplierId:'001',supplierSku:'0007',identityRows:f.identity,linkRows:f.supplierLinks,identityComplete:true,linksComplete:true,evidenceRef:'evidence-1'});
 for(const change of [f=>f.identity.push({...f.identity[0],productId:'b',active:false}),f=>f.identity[0].variantId='V1',f=>f.identity[0].active=false,f=>f.supplierLinks=[],f=>f.supplierLinks[0].supplierSku='7']){
  const f=fixture();change(f);assert.equal(projectPurchasingSupplierEvidence(args(f)).state,'needs_review');
 }
});
