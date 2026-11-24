import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProductIdentity, createLightspeedProductsRead } from '../services/lightspeed/products.js';
import { inspectCategoryHierarchy, createLightspeedCatalogRead, normalizeProductCategories } from '../services/lightspeed/catalog.js';
import { scorePotentialMatch } from '../services/lightspeed/productIdentity.js';
const complete = {complete:true};
test('literal identifiers retain zeros and inactive collisions', () => {
  const rows = [{id:'A',sku:'000123',active:true},{id:'B',upc:'000123',active:false}];
  const r = inspectProductIdentity('000123',rows,complete);
  assert.equal(r.status,'AMBIGUOUS');
  assert.deepEqual(r.candidates.map(x=>x.active),[true,false]);
  assert.equal(inspectProductIdentity('123',rows,complete).status,'NO_MATCH');
  assert.equal(inspectProductIdentity('000123',[rows[1]],complete).status,'EXACT_UNIQUE');
});
test('case and numeric punctuation compatibility are candidates only', () => {
  assert.equal(inspectProductIdentity('AbC',[{id:'A',sku:'abc'}],complete).status,'CANDIDATES');
  assert.equal(inspectProductIdentity('000123',[{id:'A',upc:'000-123'}],complete).status,'CANDIDATES');
  assert.equal(inspectProductIdentity('000123',[{id:'A',sku:'000123'},{id:'B',upc:'000-123'}],complete).status,'AMBIGUOUS');
});
test('unknown coverage, malformed IDs and numeric identifiers cannot certify absence', () => {
  assert.equal(inspectProductIdentity('000123',[]).status,'INCOMPLETE');
  assert.equal(inspectProductIdentity('000123',[{id:'A',sku:123}],complete).status,'INCOMPLETE');
  assert.equal(inspectProductIdentity('000123',[{sku:'000123'}],complete).status,'INCOMPLETE');
  assert.throws(()=>inspectProductIdentity(123,[],complete),TypeError);
});
test('repeated identity merges evidence but conflicting activity invalidates coverage', () => {
  const rows=[{id:'A',sku:'000123',active:true},{id:'A',upc:'000123',active:true}];
  assert.equal(inspectProductIdentity('000123',rows,complete).status,'EXACT_UNIQUE');
  rows[1].active=false;
  assert.equal(inspectProductIdentity('000123',rows,complete).status,'INCOMPLETE');
});
test('legacy fuzzy score remains ranking only', () => {
  assert.equal(scorePotentialMatch('AB-123',{sku:'AB 123'}).score,100);
  assert.equal(inspectProductIdentity('AB-123',[{id:'A',sku:'AB 123'}],complete).status,'NO_MATCH');
});
test('legacy exact reader still verifies both paths and rejects inactive collision', async () => {
  const paths=[];
  const transport={request:async path=>{paths.push(path);return {data:[{id:path.includes('/search?')?'B':'A',sku:'000123',active:!path.includes('/search?')}]};}};
  await assert.rejects(createLightspeedProductsRead({transport}).exact('000123'),e=>e.code==='LIGHTSPEED_AMBIGUOUS_IDENTITY');
  assert.equal(paths.length,2);
});
test('category parity and parent diagnostics', () => {
  const rows={data:[{id:'R',name:'Root'},{id:'C',name:'Child',parent_id:'R'}]};
  const r=inspectCategoryHierarchy(rows);
  assert.deepEqual(r.categories,normalizeProductCategories(rows));
  assert.equal(r.categories.find(x=>x.id==='C').path,'Root › Child');
  assert.equal(r.hierarchyValid,true);
  assert.equal(inspectCategoryHierarchy([{id:'A',name:'A',parent_id:'X'}]).issues[0].code,'CATEGORY_PARENT_MISSING');
  assert.equal(inspectCategoryHierarchy([{id:'A',name:'A',parent_id:'B'},{id:'B',name:'B',parent_id:'A'}]).issues.length,2);
});
test('catalog reader keeps existing routes and reference identifier strings', async () => {
  const paths=[];
  const transport={request:async path=>{paths.push(path);return {data:[{id:'000123',name:'Reference'}]};}};
  const read=createLightspeedCatalogRead({transport});
  for(const method of ['categories','suppliers','brands','tags']) assert.equal((await read[method]())[0].id,'000123');
  assert.deepEqual(paths,['/api/2026-07/product_categories?page_size=1000&include=family','/api/2026-04/suppliers?page_size=1000','/api/2026-04/brands?page_size=1000','/api/2026-04/tags?page_size=1000']);
});
