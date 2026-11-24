import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCatalogMutation,inspectCatalogMutationApproval,inspectCatalogReadback} from '../services/lightspeed/productCatalogMutationCandidate.js';
const target={productId:'000P',variantId:null};
const ev={source:'fixture',provenance:'row'};
const refs=()=>Object.fromEntries(['suppliers','brands','manufacturers','departments','categories','tags'].map(k=>[k,[]]));
const snapshot=()=>({complete:true,version:'v1',products:[{...target,active:true,values:{name:'Old',sku:'0007',cost:'12.00'}}],identity:[{...target,active:true,identifiers:[{kind:'SKU',exactValue:'0007',...ev}]}],links:[],identityComplete:true,linksComplete:true,references:refs(),referencesComplete:true});
const req=(desired={name:'New'},t=target)=>({requestId:'req-01',target:t,desired,expectedVersion:'v1'});
const plan=(desired={name:'New'},s=snapshot(),t=target)=>prepareCatalogMutation({request:req(desired,t),snapshot:s});
test('derives update and cost effects from trusted existing record and actual changed fields',()=>{
 const p=plan({name:'New',cost:'13.00',sku:'0007'});assert.equal(p.state,'review_required');assert.deepEqual(p.plan.operations,['catalog.product.update','catalog.product.cost.modify']);assert.deepEqual(p.plan.changedFields,['cost','name']);assert.equal(p.executable,false);
});
test('creates only absent exact target with complete identity evidence',()=>{
 const p=plan({name:'New',sku:'0008'},snapshot(),{productId:'000Q',variantId:null});assert.equal(p.plan.effect,'create');assert.equal(p.executable,false);
 assert.equal(plan({name:'New',sku:'0007'},snapshot(),{productId:'000Q',variantId:null}).state,'needs_review');
});
test('inactive collision and incomplete identity prevent creation',()=>{
 const s=snapshot();s.identity[0].active=false;assert.equal(plan({name:'New',sku:'0007'},s,{productId:'Q',variantId:null}).state,'needs_review');
 s.identityComplete=false;assert.equal(plan({name:'New',sku:'0008'},s,{productId:'Q',variantId:null}).state,'needs_review');
});
test('stale version, unknown prior value, unknown field, and variant creation fail closed',()=>{
 const s=snapshot();s.version='v2';assert.equal(plan({name:'New'},s).state,'needs_review');
 assert.equal(plan({retail:'10.00'}).state,'needs_review');assert.equal(plan({hiddenCost:'1.00'}).state,'needs_review');
 assert.equal(plan({name:'New',sku:'0008'},snapshot(),{productId:'Q',variantId:'V'}).state,'needs_review');
});
test('supplier reassignment requires separate relationship review',()=>{
 assert.equal(plan({supplierId:'S1'}).state,'needs_review');
 const s=snapshot();s.references.suppliers=[{id:'S1',name:'Supplier',...ev}];
 assert.equal(plan({name:'New',sku:'0008',supplierId:'S1',supplierSku:'001'},s,{productId:'Q',variantId:null}).reason,'separate_supplier_mapping_review');
});
test('approval bound to content and all canonical effects checked again',async()=>{
 const p=plan({cost:'13.00'}),a={reviewRef:'review-1',fingerprint:p.fingerprint};const seen=[];
 assert.equal((await inspectCatalogMutationApproval({proposal:p,approval:a,authorize:r=>{seen.push(r.operation);return true;}})).state,'fixture_checks_passed');
 assert.deepEqual(seen,['catalog.product.update','catalog.product.cost.modify','catalog.product.update.approve','catalog.product.update.execute']);
 assert.equal((await inspectCatalogMutationApproval({proposal:p,approval:a,authorize:r=>r.operation!=='catalog.product.cost.modify'})).state,'needs_review');
 p.plan.after.cost='14.00';assert.equal((await inspectCatalogMutationApproval({proposal:p,approval:a,authorize:()=>true})).state,'needs_review');
});
test('missing approval and revoked execution decision deny',async()=>{
 const p=plan(),a={reviewRef:'review-1',fingerprint:p.fingerprint};
 assert.equal((await inspectCatalogMutationApproval({proposal:p,authorize:()=>true})).state,'needs_review');
 assert.equal((await inspectCatalogMutationApproval({proposal:p,approval:a,authorize:r=>r.operation!=='catalog.product.update.execute'})).state,'needs_review');
});
test('readback requires exact target, new version, complete evidence and exact changed values',()=>{
 const p=plan({cost:'13.00'}),obs={...target,complete:true,fingerprint:p.fingerprint,version:'v2',values:{cost:'13.00'}};
 assert.equal(inspectCatalogReadback({proposal:p,observation:obs}).state,'verified_evidence');
 for(const patch of [{complete:false},{version:'v1'},{variantId:'V'},{values:{cost:'13'}},{fingerprint:'a'.repeat(64)}]){
 const r=inspectCatalogReadback({proposal:p,observation:{...obs,...patch}});assert.equal(r.state,'unknown');assert.equal(r.retryAllowed,false);
 }
});
