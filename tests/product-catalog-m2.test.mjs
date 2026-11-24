import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectTypedProductIdentity,scorePotentialMatch} from '../services/lightspeed/productIdentity.js';
const complete={complete:true};
const evidence=(kind,exactValue,scope={})=>({kind,exactValue,...scope,source:'fixture',provenance:'fixture-row'});
const row=(productId,identifiers,variantId=null,active=true)=>({productId,variantId,active,identifiers});
const inspect=(q,rows,coverage=complete)=>inspectTypedProductIdentity(q,rows,coverage);
test('exact text and kind remain distinct including UPC and GTIN',()=>{
 const rows=[row('P1',[evidence('SKU','000123')]),row('P2',[evidence('UPC','000123')])];
 assert.equal(inspect({kind:'SKU',exactValue:'000123'},rows).candidates[0].productId,'P1');
 assert.equal(inspect({kind:'GTIN',exactValue:'000123'},rows).status,'NO_MATCH');
 for(const value of ['123','000-123',' 000123']) assert.equal(inspect({kind:'SKU',exactValue:value},rows).status,'NO_MATCH');
});
test('supplier code is scoped to canonical supplier ID',()=>{
 const q={kind:'SUPPLIER_SKU',exactValue:'0007',supplierId:'S1'};
 const rows=[row('P1',[evidence(q.kind,q.exactValue,{supplierId:'S1'})]),row('P2',[evidence(q.kind,q.exactValue,{supplierId:'S2'})])];
 assert.equal(inspect(q,rows).candidates[0].productId,'P1');
 assert.throws(()=>inspect({kind:q.kind,exactValue:q.exactValue},rows),TypeError);
 rows.push(row('P3',[evidence(q.kind,q.exactValue,{supplierId:'S1'})],null,false));
 assert.equal(inspect(q,rows).status,'AMBIGUOUS');
});
test('manufacturer scope is separate and cannot be substituted with supplier scope',()=>{
 const q={kind:'MANUFACTURER_PART',exactValue:'A-01',manufacturerId:'M1'};
 assert.equal(inspect(q,[row('P1',[evidence(q.kind,q.exactValue,{manufacturerId:'M2'})])]).status,'NO_MATCH');
 assert.throws(()=>inspect({...q,supplierId:'S1'},[]),TypeError);
});
test('variant collisions and inactive matches remain distinct',()=>{
 const q={kind:'SKU',exactValue:'0007'},code=evidence(q.kind,q.exactValue);
 const result=inspect(q,[row('P',[code],'V1'),row('P',[code],'V2',false),row('P',[code])]);
 assert.equal(result.status,'AMBIGUOUS');
 assert.deepEqual(result.candidates.map(x=>[x.variantId,x.active]),[['V1',true],['V2',false],[null,true]]);
});
test('duplicate observations merge and retain evidence provenance',()=>{
 const q={kind:'SKU',exactValue:'A'};
 const code=evidence(q.kind,q.exactValue);
 const r=inspect(q,[row('P',[code]),row('P',[code,{...code,provenance:'second-row'}])]);
 assert.equal(r.status,'EXACT_UNIQUE');
 assert.equal(r.candidates[0].evidence.length,2);
});
test('incomplete coverage and malformed evidence cannot certify absence',()=>{
 const q={kind:'SKU',exactValue:'0007'};
 assert.equal(inspect(q,[],{}).status,'INCOMPLETE');
 assert.equal(inspect(q,[row('P',[evidence('SKU',7)])]).status,'INCOMPLETE');
 assert.equal(inspect(q,[row('P',[{kind:'SKU',exactValue:'0007'}])]).status,'INCOMPLETE');
 assert.equal(inspect(q,[row('P',[evidence('SUPPLIER_SKU','0007')])]).status,'INCOMPLETE');
 assert.throws(()=>inspect({kind:'SKU',exactValue:7},[]),TypeError);
});
test('conflicting activity invalidates coverage even on nonmatching observation',()=>{
 const q={kind:'SKU',exactValue:'A'},code=evidence(q.kind,q.exactValue);
 assert.equal(inspect(q,[row('P',[code]),row('P',[],null,false)]).status,'INCOMPLETE');
});
test('legacy fuzzy scoring remains unchanged; typed exact is stricter',()=>{
 assert.equal(scorePotentialMatch('AB-123',{sku:'AB 123'}).score,100);
 assert.equal(inspect({kind:'SKU',exactValue:'AB-123'},[row('P',[evidence('SKU','AB 123')])]).status,'NO_MATCH');
});
