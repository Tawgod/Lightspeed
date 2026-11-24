import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSupplierIdentity,inspectSupplierProductLinks,inspectCatalogPrices,inspectCatalogReferences} from '../services/lightspeed/catalog.js';
const complete={complete:true}, target={productId:'000P',variantId:null};
const ev={source:'fixture',provenance:'row-01',observedAt:'2026-11-24T10:00:00.000Z'};
const alias=(supplierId,over={})=>({...ev,supplierId,alias:'Vendor A',verified:true,...over});
const link=(supplierId,primary,over={})=>({...ev,...target,supplierId,primary,supplierSku:'0007',...over});
const price=(kind,amount,over={})=>({...ev,...target,kind,amount,currency:'USD',supplierId:null,outletId:null,...over});
const refs=()=>Object.fromEntries(['suppliers','brands','manufacturers','departments','categories','tags'].map(k=>[k,[]]));
test('alias resolution is exact, source-scoped and keeps provenance',()=>{
 const q={source:'fixture',alias:'Vendor A'};
 const r=resolveSupplierIdentity(q,[alias('001'),alias('002',{source:'other'}),alias('003',{alias:'vendor a'})],complete);
 assert.equal(r.status,'EXACT_UNIQUE');assert.equal(r.candidates[0].supplierId,'001');
 assert.equal(r.candidates[0].evidence[0].provenance,'row-01');
});
test('conflicting or unverified aliases cannot resolve',()=>{
 const q={source:'fixture',alias:'Vendor A'};
 assert.equal(resolveSupplierIdentity(q,[alias('001'),alias('002')],complete).status,'AMBIGUOUS');
 assert.equal(resolveSupplierIdentity(q,[alias('001'),alias('002',{verified:false})],complete).status,'INCOMPLETE');
 assert.equal(resolveSupplierIdentity(q,[]).status,'INCOMPLETE');
});
test('secondary suppliers never replace primary, identifiers and variant preserved',()=>{
 const r=inspectSupplierProductLinks(target,[link('001',true),link('002',false),link('003',true,{variantId:'V1'})],complete);
 assert.equal(r.primarySupplierId,'001');assert.equal(r.links.length,2);
 assert.equal(r.links[1].supplierSku,'0007');assert.equal(r.complete,true);
});
test('multiple primaries and contradictory SKU evidence fail closed',()=>{
 const r=inspectSupplierProductLinks(target,[link('001',true),link('002',true),link('001',true,{supplierSku:'0008'})],complete);
 assert.equal(r.primarySupplierId,null);assert.equal(r.complete,false);
 assert.ok(r.issues.includes('MULTIPLE_PRIMARY_SUPPLIERS'));assert.ok(r.issues.includes('CONFLICTING_SUPPLIER_SKU'));
});
test('unknown primary and incomplete coverage do not select a supplier',()=>{
 assert.equal(inspectSupplierProductLinks(target,[link('001',true),link('002',null)],complete).primarySupplierId,null);
 assert.equal(inspectSupplierProductLinks(target,[link('001',true)]).primarySupplierId,null);
 assert.equal(inspectSupplierProductLinks(target,[link('001',true),link('001',false)],complete).primarySupplierId,null);
});
test('price types, supplier and outlet scope and decimal strings are distinct',()=>{
 const r=inspectCatalogPrices(target,[price('COST','12.3400',{supplierId:'001'}),price('COST','9.99',{supplierId:'002'}),price('MSRP','20.00'),price('RETAIL','0.00',{outletId:'O1'})],complete);
 assert.deepEqual(r.prices.map(p=>p.amount),['12.3400','9.99','20.00','0.00']);
 assert.equal(r.complete,true);
});
test('unknown prices remain null and conflicts never select a price',()=>{
 const r=inspectCatalogPrices(target,[price('COST',null),price('RETAIL','10.00'),price('RETAIL','11.00')],complete);
 assert.deepEqual(r.prices.map(p=>p.amount),[null,null]);assert.equal(r.complete,false);
 assert.ok(r.issues.includes('CONFLICTING_PRICE'));
});
test('numeric amounts, missing currency and impossible dates rejected',()=>{
 const r=inspectCatalogPrices(target,[price('COST',12),price('MSRP','12',{currency:null}),price('RETAIL','12',{observedAt:'2026-02-30T10:00:00.000Z'})],complete);
 assert.equal(r.complete,false);assert.equal(r.prices.length,0);
});
test('reference lists preserve exact IDs and detect duplicates and missing lists',()=>{
 const input=refs();input.suppliers=[{...ev,id:'001',name:'A'},{...ev,id:'001',name:'B'}];delete input.tags;
 const r=inspectCatalogReferences(input,complete);assert.equal(r.references.suppliers[0].id,'001');
 assert.equal(r.complete,false);assert.ok(r.issues.some(x=>x.code==='DUPLICATE_REFERENCE_ID'));
 assert.ok(r.issues.some(x=>x.code==='MISSING_REFERENCE_LIST'));
});
test('strict category and department parent diagnostics reuse existing hierarchy rules',()=>{
 const input=refs();input.categories=[{...ev,id:'C',name:'Child',parent_id:'missing'}];
 input.departments=[{...ev,id:'D1',name:'One',parent_id:'D2'},{...ev,id:'D2',name:'Two',parent_id:'D1'}];
 const r=inspectCatalogReferences(input,complete);assert.equal(r.complete,false);
 assert.ok(r.issues.some(x=>x.kind==='categories'&&x.code==='CATEGORY_PARENT_MISSING'));
 assert.ok(r.issues.some(x=>x.kind==='departments'&&x.code==='CATEGORY_CYCLE'));
 assert.equal(inspectCatalogReferences(refs(),complete).complete,true);
});
