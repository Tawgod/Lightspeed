import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConsignmentProductPreview } from '../services/consignmentProductPreview.js';
import { normalizeMatches, toSpecialOrderMatchRequest } from '../extension/product-scanner/special-orders-adapter.js';
test('new-product descriptive template never copies new inventory, image or identifiers',()=>{
 const original={id:'new-123',name:'Ticket to Ride',brand_id:'brand-abc',description:'Strategy board game',
  images:[{url:'private.example'}],image_url:'private.example',sku:'NEW-001',upc:'000000000000',
  inventory:100,supply_price:4,supplier_id:'supplier-x'};
 const draft=buildConsignmentProductPreview({item:{id:'UG-001300',name:'Ticket to Ride',price:25},
  selectedOriginal:original,categoryId:'category-consignment'});
 assert.equal(draft.preview.name,'USED — Ticket to Ride');
 assert.equal(draft.preview.sku,'UG-001300');
 assert.equal(draft.preview.price_excluding_tax,25);
 assert.equal(draft.preview.product_category_id,'category-consignment');
 assert.equal(draft.preview.description,'Strategy board game');
 assert.equal(draft.preview.brand_id,'brand-abc');
 for (const disallowed of ['images','image','image_url','upc','product_codes','inventory','supplier_id','supply_price']){
  assert.equal(Object.hasOwn(draft.preview,disallowed),false,disallowed);
 }
 assert.equal(draft.imagesCopied,false);
 assert.equal(draft.onlineEnabled,false);
 assert.equal(draft.canPostViaExistingSpecialOrdersRoute,false);
});
test('no accidental used-to-used reactivation or missing category',()=>{
 assert.throws(()=>buildConsignmentProductPreview({item:{id:'UG-001300',name:'A',price:20},selectedOriginal:{name:'USED — A'},categoryId:'category-consignment'}),/used product/);
 assert.throws(()=>buildConsignmentProductPreview({item:{id:'UG-001300',name:'A',price:20}}),/category/);
 assert.throws(()=>buildConsignmentProductPreview({item:{id:'NEW-01',name:'A',price:20},categoryId:'category-consignment'}),/consignment item code/);
});
test('scanner match adapter preserves local/remote same product identity',()=>{
 const request=toSpecialOrderMatchRequest({name:'Ticket to Ride',sku:'DOW7201',upc:''});
 assert.equal(request.name,'Ticket to Ride');
 const results=normalizeMatches([{lightspeed_product_id:'abc',name:'Ticket to Ride',score:82}], [{id:'abc',name:'Ticket to Ride',score:93}]);
 assert.equal(results.length,1);
 assert.equal(results[0].score,93);
 assert.equal(results[0].sources.length,2);
});
test('approved accounting cost is an explicit input, not assumed 80%',()=>{
 const item={id:'PZ-001300',name:'Puzzle',price:10};
 const draft=buildConsignmentProductPreview({item,categoryId:'cat',approvedAccountingCost:8});
 assert.equal(draft.preview.supply_price,8);
 assert.equal(draft.canPostViaExistingSpecialOrdersRoute,true);
});
