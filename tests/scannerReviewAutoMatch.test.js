import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMatches,toSpecialOrderMatchRequest} from '../extension/product-scanner/special-orders-adapter.js';
import {publicScannerMatch,validateScannerLookup} from '../routes/scannerMatchGateway.js';

test('existing product match carries SKU description and known completeness attributes',()=>{
  const rows=normalizeMatches([],[
    publicScannerMatch({id:'abc',name:'Game',sku:'GAME1',upc:'850052382605',description:'Great game',weight:null,images:[]},'lightspeed')
  ]);
  assert.equal(rows[0].sku,'GAME1');
  assert.equal(rows[0].description,'Great game');
  assert.equal(rows[0].upc,'850052382605');
  assert.equal(rows[0].weightKnown,true);
  assert.equal(rows[0].pictureKnown,true);
  assert.equal(rows[0].imageUrl,'');
});
test('local matches are not falsely marked missing weight or image',()=>{
  const rows=normalizeMatches([
    publicScannerMatch({local_id:3,name:'Game',sku:'GAME1',description:'Store description',upc:''},'local')
  ],[]);
  assert.equal(rows[0].weightKnown,false);
  assert.equal(rows[0].pictureKnown,false);
});
test('supplier number and UPC remain independent of general SKU and capture MAP separately',()=>{
  const req=toSpecialOrderMatchRequest({sku:'STORE-100',supplierSku:'ACD-200',upc:'850052382605',mapPrice:'59.99',name:'Sample'});
  assert.equal(req.product_code,'850052382605');
  assert.equal(req.sku,'STORE-100');
  assert.equal(req.supplier_sku,'ACD-200');
  assert.equal(req.mapPrice,undefined);
  assert.equal(validateScannerLookup(req).product_code,'850052382605');
});
test('supplier id is treated as an optional positive integer',()=>{
  assert.equal(validateScannerLookup({sku:'A',supplier_id:4}).supplier_id,4);
  assert.equal(validateScannerLookup({sku:'A',supplier_id:'4 OR TRUE'}).supplier_id,undefined);
});
