import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normalizeMatches} from '../extension/product-scanner/special-orders-adapter.js';
import {productCompleteness} from '../extension/product-scanner/completeness.js';

test('duplicate merge preserves missing cached UPC and description from Lightspeed',()=>{
  const rows=normalizeMatches(
    [{local_id:5,lightspeed_product_id:'L1',name:'Widget',sku:'STORE',upc:'',description:'',weightKnown:false,pictureKnown:false}],
    [{id:'L1',name:'Widget',sku:'STORE',upc:'850052382605',description:'Full details',weight:null,weightKnown:true,imageUrl:'',pictureKnown:true}]
  );
  assert.equal(rows.length,1);
  assert.equal(rows[0].upc,'850052382605');
  assert.equal(rows[0].description,'Full details');
  assert.deepEqual(productCompleteness(rows[0]),{missing:['Weight','Picture'],unknown:[]});
});
test('unknown weight and image are never reported as absent',()=>{
  assert.deepEqual(productCompleteness({upc:'012345678905',weightKnown:false,pictureKnown:false}),{missing:[],unknown:['Weight','Picture']});
});
test('zero weights with units are missing; positive values are present',()=>{
  assert.deepEqual(productCompleteness({upc:'1',weight:'0 lbs',weightKnown:true,pictureKnown:true,imageUrl:'https://a.example/img.jpg'}).missing,['Weight']);
  assert.deepEqual(productCompleteness({upc:'1',weight:'4.5 oz',weightKnown:true,pictureKnown:true,imageUrl:'https://a.example/img.jpg'}).missing,[]);
});
test('remote duplicate matcher rejects failed and malformed Lightspeed responses',()=>{
  const source=fs.readFileSync('routes/specialOrderProducts.js','utf8');
  const start=source.indexOf("router.post('/products/match-remote'");
  const end=source.indexOf("router.get('/products/potential-matches'",start);
  assert.ok(start>=0 && end>start);
  const route=source.slice(start,end);
  assert.match(route,/Promise\.allSettled/);
  assert.match(route,/results\.some\(r=>r\.status!=='fulfilled' \|\| !Array\.isArray\(r\.value\?\.data\)\)/);
  assert.match(route,/return res\.status\(502\)/);
  assert.match(route,/uniqueCodes/);
});
test('multiple-product supplier pages cannot enter review or staging',()=>{
  const source=fs.readFileSync('extension/product-scanner/review.js','utf8');
  assert.match(source,/if\(d\.requiresSelection\)\{/);
  assert.match(source,/No matching or new-item proposal allowed from a multi-product page/);
  assert.match(source,/draftAvailable=false;/);
});
