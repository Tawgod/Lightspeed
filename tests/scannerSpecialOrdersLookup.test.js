import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpecialOrdersMatchLookup} from '../services/scannerSpecialOrdersLookup.js';

test('rejects non-loopback upstream and missing key',()=>{
  assert.throws(()=>createSpecialOrdersMatchLookup({baseUrl:'https://supplier.example',adminKey:'secret'}),/loopback-only/);
  assert.throws(()=>createSpecialOrdersMatchLookup({adminKey:''}),/authentication/);
});
test('forwards matching requests to the existing Special Orders routes with server-only key',async()=>{
  const requests=[];
  const lookup=createSpecialOrdersMatchLookup({
    baseUrl:'http://127.0.0.1:8080',adminKey:'test-key',
    fetchImpl:async(url,options)=>{
      requests.push({url:String(url),options});
      return {ok:true,json:async()=>({matches:[]})};
    }
  });
  await lookup('local',{sku:'ABC'});
  await lookup('remote',{product_code:'012345678901'});
  assert.equal(requests.length,2);
  assert.equal(requests[0].url,'http://127.0.0.1:8080/api/special-orders/products/match-local');
  assert.equal(requests[1].url,'http://127.0.0.1:8080/api/special-orders/products/match-remote');
  assert.equal(requests[0].options.headers['x-hobby-corner-key'],'test-key');
  assert.equal(requests[0].options.redirect,'error');
});
test('fails closed on backend errors and partial data',async()=>{
  const backendFailure=createSpecialOrdersMatchLookup({adminKey:'key',fetchImpl:async()=>({ok:false,status:401})});
  await assert.rejects(()=>backendFailure('local',{sku:'ABC'}),/failed/);
  const malformed=createSpecialOrdersMatchLookup({adminKey:'key',fetchImpl:async()=>({ok:true,json:async()=>({})})});
  await assert.rejects(()=>malformed('remote',{sku:'ABC'}),/invalid data/);
  await assert.rejects(()=>malformed('other',{}),/Unknown/);
});
