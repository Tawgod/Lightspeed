import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCatalogConsumerView} from '../services/lightspeed/productCatalogProjection.js';
const target={productId:'000P',variantId:null};
const ev={source:'fixture',provenance:'row-1',observedAt:'2026-11-24T10:00:00.000Z'};
const kinds=['suppliers','brands','manufacturers','departments','categories','tags'];
const emptyRefs=()=>Object.fromEntries(kinds.map(k=>[k,[]]));
const fixture=()=>{
 const referenceIds=emptyRefs();referenceIds.suppliers=['001'];
 const references=emptyRefs();references.suppliers=[{...ev,id:'001',name:'Supplier'}];
 return {identity:[{...target,name:'Product',active:true,identifiers:[{...ev,kind:'SKU',exactValue:'000123'}],referenceIds}],
 supplierLinks:[{...target,...ev,supplierId:'001',supplierSku:'0007',primary:true}],
 prices:[{...target,...ev,kind:'RETAIL',amount:'12.3400',currency:'USD',supplierId:null,outletId:null}],
 assets:[{...target,...ev,assetId:'A',kind:'IMAGE',role:'PRIMARY',slot:0,availability:'AVAILABLE',reference:{kind:'STORAGE_ID',value:'secret-storage'}}],
 references,coverage:{identity:true,supplierLinks:true,prices:true,references:true,assets:true}};
};
test('composes existing inspectors with exact strings and independent sections',()=>{
 const r=projectCatalogConsumerView(target,fixture());
 assert.equal(r.complete,true);assert.equal(r.product.identifiers[0].exactValue,'000123');
 assert.equal(r.primarySupplierId,'001');assert.equal(r.prices[0].amount,'12.3400');assert.equal(r.primaryImageId,'A');
 assert.equal(r.supplierLinks[0].supplierSku,'0007');
});
test('missing section coverage never inherits global completeness',()=>{
 const f=fixture();delete f.coverage.assets;f.complete=true;
 const r=projectCatalogConsumerView(target,f);assert.equal(r.complete,false);assert.equal(r.coverage.assets,false);assert.equal(r.primaryImageId,null);
});
test('inactive variant collision prevents identity completeness',()=>{
 const f=fixture();f.identity.push({...f.identity[0],variantId:'V1',active:false});
 const r=projectCatalogConsumerView(target,f);assert.equal(r.coverage.identity,false);
 assert.equal(r.product.identifiers[0].status,'AMBIGUOUS');assert.equal(r.complete,false);
});
test('does not infer product from metadata or parent',()=>{
 const r=projectCatalogConsumerView({...target,variantId:'V1'},fixture());
 assert.equal(r.observed,false);assert.equal(r.product,null);assert.equal(r.complete,false);
});
test('conflicting activity or names do not select arbitrary values',()=>{
 const f=fixture();f.identity.push({...f.identity[0],name:'Other',active:false});
 const r=projectCatalogConsumerView(target,f);assert.equal(r.product.name,null);assert.equal(r.product.active,null);assert.equal(r.complete,false);
});
test('unresolved canonical supplier prevents primary selection and completeness',()=>{
 const f=fixture();f.references.suppliers=[];
 const r=projectCatalogConsumerView(target,f);assert.equal(r.primarySupplierId,null);assert.equal(r.complete,false);
 assert.ok(r.issues.some(x=>x.code==='UNRESOLVED_SUPPLIER_REFERENCE'));
});
test('conflicting prices remain null without guessing',()=>{
 const f=fixture();f.prices.push({...f.prices[0],amount:'13.00'});
 const r=projectCatalogConsumerView(target,f);assert.equal(r.prices[0].amount,null);assert.equal(r.coverage.prices,false);
});
test('no raw payload, credentials or asset location exposed by display projection',()=>{
 const f=fixture();f.identity[0].raw={token:'secret-token'};f.prices[0].raw='secret-price';
 const serialized=JSON.stringify(projectCatalogConsumerView(target,f));
 for(const forbidden of ['secret-token','secret-price','secret-storage','row-1'])assert.equal(serialized.includes(forbidden),false);
});
test('missing arrays, invalid identifiers and reference associations fail closed',()=>{
 const f=fixture();delete f.assets;f.identity[0].identifiers=[{kind:'SKU',exactValue:123}];delete f.identity[0].referenceIds.tags;
 const r=projectCatalogConsumerView(target,f);assert.equal(r.complete,false);assert.equal(r.product.referenceIds.tags,null);
 assert.ok(r.issues.some(x=>x.code==='MISSING_EVIDENCE'));assert.ok(r.issues.some(x=>x.code==='INVALID_IDENTIFIER'));
});
