import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreReadExecutor } from '../services/lightspeed/coreReadContract.js';
import { createLightspeedTransport, LightspeedTransportError } from '../services/lightspeed/client.js';
import { readLightspeedCollection, LightspeedIncompleteReadError } from '../services/lightspeed/readCollection.js';

test('versioned success and server correlation reach admission and reader', async () => {
  let trace;
  const run=createCoreReadExecutor({environment:'test',authorizeRead: async a=>{trace=a.correlationId;assert.equal(a.operation,'products.exact');assert.equal(a.mode,'read');return true;}});
  const r=await run({operation:'products.exact',read:async a=>{assert.equal(a.correlationId,trace);return {sku:'0001'};}});
  assert.deepEqual(r,{status:200,body:{version:'core.v1',readOnly:true,correlationId:trace,data:{sku:'0001'}}});
});
test('denial, truthy non-grant and verifier outage never call reader', async () => {
  for(const authorizeRead of [async()=>false,async()=>({allowed:true}),async()=>{throw Error('secret');}]){
    const run=createCoreReadExecutor({environment:'test',authorizeRead});
    const r=await run({operation:'products.exact',read:()=>assert.fail('read called')});
    assert.equal(r.status,403);assert.equal(r.body.error.code,'CORE_FORBIDDEN');
    assert.ok(!JSON.stringify(r).includes('secret'));
  }
});
test('safe errors never expose vendor message, payload or uncertain-write retry', async () => {
  const run=createCoreReadExecutor({environment:'test',authorizeRead:async()=>true});
  for(const [error,code,retryable] of [
    [new LightspeedIncompleteReadError('secret'),'LIGHTSPEED_INCOMPLETE_READ',false],
    [new LightspeedTransportError('secret',{code:'LIGHTSPEED_NETWORK',retryable:true}),'LIGHTSPEED_NETWORK',true],
    [new LightspeedTransportError('secret',{code:'LIGHTSPEED_NETWORK',retryable:true,mayHaveWritten:true}),'CORE_UNAVAILABLE',false],
    [Error('secret'),'CORE_UNAVAILABLE',false]]){
    const r=await run({operation:'products.exact',read:async()=>{throw error;}});
    assert.equal(r.body.error.code,code);assert.equal(r.body.error.retryable,retryable);
    assert.ok(!JSON.stringify(r).includes('secret'));
  }
});
test('pagination rejects invalid continuation before second request', async () => {
  for(const next of ['/api/2026-04/customers','?page=2#fragment','/api/2026-04/%2e/items',false,42,'']){
    let calls=0;
    const transport={request:async()=>{calls++;return {data:[{id:'1'}],links:{next}};}};
    await assert.rejects(readLightspeedCollection({transport,path:'/api/2026-04/items?page_size=2'}),LightspeedIncompleteReadError);
    assert.equal(calls,1);
  }
});
test('unsafe offset and non-scalar cursor fail closed', async () => {
  await assert.rejects(readLightspeedCollection({transport:{request:async()=>({data:[1]})},path:'/api/2.0/search?page_size=1&offset=9007199254740991'}),LightspeedIncompleteReadError);
  await assert.rejects(readLightspeedCollection({transport:{request:async()=>({data:[1],version:{max:[123]}})},path:'/api/2.0/products'}),LightspeedIncompleteReadError);
});
test('valid relative continuation stays compatible', async () => {
  let calls=0;
  const rows=await readLightspeedCollection({transport:{request:async()=>++calls===1?{data:[1],links:{next:'?page=2'}}:{data:[2],links:{next:null}}},path:'/api/2.0/products?page=1'});
  assert.deepEqual(rows,[1,2]);
});
test('transport retries bounded reads and never retries attempted writes', async () => {
  let calls=0;
  const fetchImpl=async()=>{calls++;return new Response('{}',{status:503});};
  const t=createLightspeedTransport({domain:'fixture',token:'fake',fetchImpl,readRetries:2,mutationsAllowed:true});
  await assert.rejects(t.request('/api/2.0/products'),e=>e.retryable===true && !e.mayHaveWritten);
  assert.equal(calls,3);
  await assert.rejects(t.request('/api/2.0/products',{method:'POST',body:{}}),e=>e.mayHaveWritten===true && !e.retryable);
  assert.equal(calls,4);
});
test('default transport denies POST before network and supplies timeout signal', async () => {
  let calls=0;
  const t=createLightspeedTransport({domain:'fixture',token:'fake',timeoutMs:100,fetchImpl:async(url,opts)=>{calls++;assert.ok(opts.signal instanceof AbortSignal);assert.equal(opts.redirect,'error');return new Response('{}');}});
  await assert.rejects(t.request('/api/2.0/products',{method:'POST'}),e=>e.code==='LIGHTSPEED_WRITES_DISABLED');
  assert.equal(calls,0);
  await t.request('/api/2.0/products');assert.equal(calls,1);
});

test('continuations cannot drop, replace or introduce original filters', async () => {
  for(const next of ['?page=2','?sku=123&page=2','?sku=000123&outlet=other&page=2','?sku=000123&tag=a&page=2','?sku=000123&tag=b&tag=a&page=2']){
    let calls=0;
    await assert.rejects(readLightspeedCollection({path:'/api/2.0/products?sku=000123&tag=a&tag=b&page=1',transport:{request:async()=>{calls++;return {data:[1],links:{next}};}}}),LightspeedIncompleteReadError);
    assert.equal(calls,1);
  }
});
test('conflicting continuation metadata fails without returning partial rows', async () => {
  for(const metadata of [
    {links:{next:null},pagination:{next:'?page=2'}},
    {links:{next:'?page=2'},pagination:{has_next:false}},
    {pagination:{has_next:true,hasNext:false}},
    {pagination:{has_next:'false'}},
    {next:null,pagination:{has_next:true}}
  ]){
    let calls=0;
    await assert.rejects(readLightspeedCollection({path:'/api/2.0/products?page=1',transport:{request:async()=>{calls++;return {data:[1],...metadata};}}}),LightspeedIncompleteReadError);
    assert.equal(calls,1);
  }
});
test('original query values and correlation survive multiple pages and transport', async () => {
  const seen=[];
  const transport=createLightspeedTransport({domain:'fixture',token:'fake',fetchImpl:async(url,options)=>{
    seen.push({url,trace:options.headers['X-Request-ID']});
    return new Response(JSON.stringify(seen.length===1?{data:[1],links:{next:'?tag=a&tag=b&sku=000123&page=2'}}:{data:[2],links:{next:null}}));
  }});
  const run=createCoreReadExecutor({environment:'test',authorizeRead:async()=>true});
  const result=await run({operation:'products.exact',read:({correlationId})=>readLightspeedCollection({transport,correlationId,path:'/api/2.0/products?sku=000123&tag=a&tag=b&page=1'})});
  assert.deepEqual(result.body.data,[1,2]);
  assert.equal(seen.length,2);
  assert.ok(seen.every(x=>x.trace===result.body.correlationId && new URL(x.url).searchParams.get('sku')==='000123'));
});
