import assert from 'node:assert/strict';
import test from 'node:test';
import {validateScannerLookup,publicScannerMatch,createScannerMatchGateway} from '../routes/scannerMatchGateway.js';
import {checkProductMatches} from '../extension/product-scanner/special-orders-adapter.js';

test('validates and bounds incoming match fields',()=>{
  assert.throws(()=>validateScannerLookup({}),/required/);
  assert.deepEqual(validateScannerLookup({product_code:' 01234 ',name:' A '}),{
    product_code:'01234',sku:'',supplier_sku:'',name:'A',description:''
  });
  assert.equal(validateScannerLookup({sku:'X'.repeat(400)}).sku.length,128);
});
test('removes protected supplier and inventory data from matches',()=>{
  const result=publicScannerMatch({id:17,lightspeed_product_id:'LS123',name:' Widget ',supplier_name:'Private Supplier',supply_price:1.23,stock:9,score:150},'local');
  assert.equal(result.name,'Widget');
  assert.equal(result.lightspeed_product_id,'LS123');
  assert.equal(result.score,100);
  assert.equal(result.supplier_name,undefined);
  assert.equal(result.supply_price,undefined);
  assert.equal(result.stock,undefined);
});
test('fails closed if any lookup fails', async()=>{
  await assert.rejects(()=>checkProductMatches({sku:'ABC'},async kind=>kind==='local'?{matches:[]}:Promise.reject(Error('Lightspeed unavailable'))),/Lightspeed unavailable/);
});
test('combines matches across both existing matching endpoints',async()=>{
  const result=await checkProductMatches({sku:'ABC'},async kind=>({matches:kind==='local'?[{local_id:1,lightspeed_product_id:'p1',name:'Thing',score:100}]:[{id:'p1',name:'Thing'}]}));
  assert.equal(result.verified,true);
  assert.equal(result.matches.length,1);
  assert.deepEqual(result.matches[0].sources,['railway','lightspeed']);
});
test('gateway remains constructible without authentication and is not mounted',()=>{
  const router=createScannerMatchGateway();
  assert.equal(typeof router,'function');
});
