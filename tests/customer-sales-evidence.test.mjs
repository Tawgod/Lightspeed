import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerSalesEvidence} from '../services/lightspeed/customerSalesEvidence.js';
import {createLightspeedCustomersRead, buildCustomerSearchPath} from '../services/lightspeed/customers.js';
import {createLightspeedSalesRead} from '../services/lightspeed/sales.js';
import {createLightspeedFulfillmentsRead} from '../services/lightspeed/fulfillments.js';
import {createLightspeedStoreCreditRead} from '../services/lightspeed/storeCredit.js';
const setup = handler => {
  const calls=[];
  const transport={async request(...args){assert.equal(args.length,1);calls.push(args[0]);return handler(args[0]);}};
  const readers={customers:createLightspeedCustomersRead({transport}),sales:createLightspeedSalesRead({transport}),fulfillments:createLightspeedFulfillmentsRead({transport}),storeCredit:createLightspeedStoreCreditRead({transport})};
  return {calls,readers,evidence:createCustomerSalesEvidence(readers)};
};
const incomplete=e=>e.code==='LIGHTSPEED_INCOMPLETE_READ';
test('customer get retains exact ID, strips PII, rejects mismatch',async()=>{
  const {evidence,calls}=setup(()=>({data:{id:'001',email:'private@example.test',phone:'1234567890',employee_id:'E1'}}));
  assert.deepEqual(await evidence.customer('001'),{customerId:'001',source:'lightspeed',updatedAt:null});
  assert.deepEqual(calls,['/api/2.0/customers/001']);
  await assert.rejects(evidence.customer('1'),incomplete);
  await assert.rejects(evidence.customer(1),TypeError);
});
test('contact matching paginates through existing customer reader and retains ambiguity without PII',async()=>{
  const {evidence,calls}=setup(path=>path.includes('offset=20')?{data:[{id:'002',email:'A@example.test'}]}:{data:[{id:'001',email:'a@example.test'},...Array.from({length:19},(_,i)=>({id:'other'+i,email:'other@example.test'}))]});
  const result=await evidence.matchContact('email','a@example.test');
  assert.deepEqual(result.matches.map(x=>x.customerId),['001','002']);
  assert.equal(result.ambiguous,true);assert.equal(result.requiresReview,true);
  assert.equal(result.coverage,'search-candidates-only');assert.equal(calls.length,2);
  assert.ok(!JSON.stringify(result).includes('@'));
});
test('phone formatting matches candidates only; zero matches never approves creation',async()=>{
  const {evidence}=setup(()=>({data:[{id:'01',phone:'(319) 555-0101'}]}));
  assert.equal((await evidence.matchContact('phone','319-555-0101')).matches.length,1);
  const none=await evidence.matchContact('phone','319-555-0102');
  assert.equal(none.matches.length,0);assert.equal(none.requiresReview,true);
});
test('malformed or duplicated customer evidence fails closed',async()=>{
  for(const body of [{data:[{id:'01'},{id:'01'}]},{data:[{email:'x@example.test'}]},{unexpected:true}]){
    await assert.rejects(setup(()=>body).evidence.matchContact('email','x@example.test'),incomplete);
  }
});
test('sales preserve legacy response, invoice zeros and incomplete page coverage',async()=>{
  const row={id:'S1',customer_id:'001',invoice_number:'000123',state:'OPEN',email:'secret@example.test'};
  const {evidence,readers,calls}=setup(path=>path.includes('/search?')?{data:[row]}:{data:row});
  assert.deepEqual(await readers.sales.get('S1'),{data:row});
  const result=await evidence.salesPage('invoice','000123');
  assert.equal(result.complete,false);assert.equal(result.items[0].invoiceNumber,'000123');
  assert.equal(result.items[0].deposit,null);assert.equal(result.items[0].returnEvents,null);
  assert.equal(result.items[0].partialPickup,null);assert.equal(result.items[0].email,undefined);
  assert.equal(calls[1],'/api/2.0/search?type=sales&invoice_number=000123&page_size=20');
  assert.equal((await evidence.sale('S1')).customerId,'001');
});
test('customer sale association and duplicate sales fail closed',async()=>{
  await assert.rejects(setup(()=>({data:[{id:'S1',customer_id:'02'}]})).evidence.salesPage('customer','01'),incomplete);
  await assert.rejects(setup(()=>({data:[{id:'S1',customer_id:'01'},{id:'S1',customer_id:'01'}]})).evidence.salesPage('customer','01'),incomplete);
  await assert.rejects(setup(()=>({data:{id:'S1',customer_id:'01',customer:{id:'02'}}})).evidence.sale('S1'),incomplete);
});
test('fulfillment does not infer pickup or complete coverage from status',async()=>{
  const {evidence}=setup(()=>({data:[{id:'F1',status:'COMPLETE'},{id:'F2',sale_id:'S1',status:'NEW',private:'hidden'}]}));
  const result=await evidence.fulfillmentEvidence('S1');
  assert.equal(result.complete,false);assert.equal(result.items[0].association,'request-scoped');
  assert.equal(result.items[1].association,'source-confirmed');assert.equal(result.items[0].pickedUpQuantity,null);
  assert.equal(result.items[1].raw,undefined);
  await assert.rejects(setup(()=>({data:[{id:'F1',sale_id:'S2'}]})).evidence.fulfillmentEvidence('S1'),incomplete);
});
test('credit zero string differs from missing or unverified numeric amount; no transactions exposed',async()=>{
  for(const [amount,expected] of [['0.00','0.00'],[undefined,null],[0,null],['4.25','4.25']]){
    const {evidence,calls}=setup(()=>({data:{amount,currency:'USD',transactions:[{id:'T1'}]}}));
    const result=await evidence.creditEvidence('001');
    assert.equal(result.amount,expected);assert.equal(result.transactions,null);
    assert.deepEqual(calls,['/api/2026-07/store_credits/001']);
  }
  await assert.rejects(setup(()=>({data:{customer_id:'002',amount:'1.00'}})).evidence.creditEvidence('001'),incomplete);
});
test('projection exposes no write operations and propagates upstream errors',async()=>{
  const failure=new Error('synthetic failure');
  const {evidence}=setup(()=>{throw failure;});
  assert.deepEqual(Object.keys(evidence).sort(),['creditEvidence','customer','fulfillmentEvidence','matchContact','sale','salesPage']);
  await assert.rejects(evidence.customer('01'),e=>e===failure);
});

test('malformed explicit customer reference cannot be hidden by valid nested ID', async()=>{
  for(const row of [
    {id:'S1',customer_id:1,customer:{id:'01'}},
    {id:'S1',customer_id:'',customer:{id:'01'}},
    {id:'S1',customer_id:'01',customer:{id:1}},
    {id:'S1',customer_id:'01',customer:'01'}
  ]) await assert.rejects(setup(()=>({data:row})).evidence.sale('S1'),incomplete);
});
test('state search rejects inconsistent missing and nonmatching state evidence', async()=>{
  for(const row of [
    {id:'S1',state:'CLOSED'},
    {id:'S1',state:'OPEN',status:'CLOSED'},
    {id:'S1'},
    {id:'S1',state:1,status:'OPEN'}
  ]) await assert.rejects(setup(()=>({data:[row]})).evidence.salesPage('state','OPEN'),incomplete);
  for(const row of [{id:'S1',state:'OPEN'},{id:'S1',status:'OPEN'},{id:'S1',state:'OPEN',status:'OPEN'}]){
    const {evidence,calls}=setup(()=>({data:[row]}));
    const out=await evidence.salesPage('state','OPEN');
    assert.equal(out.items[0].state,'OPEN');assert.equal(out.complete,false);
    assert.deepEqual(calls,['/api/2.0/search?type=sales&state=OPEN&page_size=1000']);
  }
});
test('fulfillment rejects conflicting nested associations and coerced raw identifiers', async()=>{
  for(const row of [
    {id:'F1',sale_id:'01',sale:{id:'02'}},
    {id:'F1',sale_id:1,sale:{id:'1'}},
    {id:'F1',sale_id:'',sale:{id:'01'}},
    {id:1,sale_id:'01'},
    {id:'F1',sale_id:'01',sale:{id:1}}
  ]) await assert.rejects(setup(()=>({data:[row]})).evidence.fulfillmentEvidence('01'),incomplete);
  const valid=await setup(()=>({data:[{id:'F1',sale_id:'01',sale:{id:'01'}}]})).evidence.fulfillmentEvidence('01');
  assert.equal(valid.items[0].association,'source-confirmed');
});
test('credit association is evidence scoped and rejects inconsistent nested IDs', async()=>{
  const read=row=>setup(()=>({data:row})).evidence.creditEvidence('01');
  assert.equal((await read({amount:'0'})).association,'request-scoped');
  assert.equal((await read({amount:'0',customer:{id:'01'}})).association,'source-confirmed');
  await assert.rejects(read({amount:'0',customer_id:'01',customer:{id:'02'}}),incomplete);
  await assert.rejects(read({amount:'0',customer_id:1}),incomplete);
});

test('shared search query builder preserves Special Orders initial URL for name email and phone',()=>{
  const fixtures=[
    ['  Jane Doe  ','type=customers&page_size=20&first_name=Jane&last_name=Doe'],
    ['Jane Mary Doe','type=customers&page_size=20&first_name=Jane&last_name=Mary+Doe'],
    ['Jane','type=customers&page_size=20&first_name=Jane'],
    ['a+b@example.test','type=customers&page_size=20&email=a%2Bb%40example.test'],
    ['+1 (319) 555-0101','type=customers&page_size=20&phone=%2B1+%28319%29+555-0101'],
    ['   ',null]
  ];
  for(const [query,expected] of fixtures) assert.equal(buildCustomerSearchPath(query),expected===null?null:'/api/2026-04/search?'+expected);
});
test('first page compatibility preserves raw rows and order; feature enrichment stays outside reader',async()=>{
  const remote=[{id:'002',first_name:'Jane',email:'j@example.test',extra:'keep'},{id:'001',first_name:'Jane'}];
  const original=structuredClone(remote);
  const {readers,calls}=setup(()=>({data:remote,links:{next:'?offset=2'}}));
  const result=await readers.customers.searchFirstPage('Jane');
  assert.deepEqual(result,{rows:original,coverage:'single-page',complete:false});
  assert.equal(calls.length,1);
  // Fixture of existing feature-owned local enrichment, not a production implementation.
  const local=new Map([['002',{id:'local-2',discord_handle:'fixture',phone:'5550101',notes:'fixture note'}]]);
  const enriched=result.rows.map(row=>{
    const saved=local.get(row.id);
    return saved?{...row,local_customer_id:saved.id,discord_handle:saved.discord_handle||null,
      facebook_messenger_id:saved.facebook_messenger_id||null,whatsapp_number:saved.whatsapp_number||null,
      special_orders_phone:saved.phone||null,special_orders_notes:saved.notes||null}:row;
  });
  assert.deepEqual(enriched,[{...original[0],local_customer_id:'local-2',discord_handle:'fixture',facebook_messenger_id:null,whatsapp_number:null,special_orders_phone:'5550101',special_orders_notes:'fixture note'},original[1]]);
  assert.deepEqual(remote,original);
});
test('different consumers can use first page or existing paginated search without local data dependency',async()=>{
  const first=Array.from({length:20},(_,i)=>({id:'C'+i}));
  const {readers,calls}=setup(path=>({data:path.includes('offset=20')?[{id:'C20'}]:first}));
  assert.equal((await readers.customers.searchFirstPage('Jane')).rows.length,20);
  assert.equal((await readers.customers.search('Jane')).length,21);
  assert.equal(calls.length,3);
  assert.equal(calls[0],calls[1]);
  assert.ok(calls[2].includes('offset=20'));
});
test('blank query never contacts vendor and first page malformed shape or upstream errors reject',async()=>{
  const failure=new Error('fixture upstream error');
  const {readers,calls}=setup(()=>{throw failure;});
  assert.deepEqual(await readers.customers.searchFirstPage('  '),{rows:[],coverage:'not-queried',complete:false});
  assert.deepEqual(await readers.customers.search(' '),[]);
  assert.equal(calls.length,0);
  await assert.rejects(readers.customers.searchFirstPage('Jane'),e=>e===failure);
  await assert.rejects(setup(()=>({unexpected:[]})).readers.customers.searchFirstPage('Jane'),incomplete);
});

// Offline route-source harness. Execute only the checked-in customer GET handler
// with injected fake vendor/DB dependencies; never import the production app.
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const routeSource=readFileSync(new URL('../special-orders.js',import.meta.url),'utf8');
const routeStart="  router.get('/customers/search', async (req, res) => {";
const routeEnd="  router.post('/customers/create-lightspeed',";
const start=routeSource.indexOf(routeStart), end=routeSource.indexOf(routeEnd,start);
assert.ok(start>=0 && end>start && routeSource.indexOf(routeStart,start+1)===-1);
const actualRoute=routeSource.slice(start,end).trim();
assert.ok(actualRoute.endsWith('});'));
const vendorStart=actualRoute.indexOf('      const response = await fetch(');
const vendorEnd=actualRoute.indexOf('\n\n      if (pool && candidates.length)',vendorStart);
assert.ok(vendorStart>=0 && vendorEnd>vendorStart);
// Proposed substitution only in memory; the rest is actual route source.
const candidateRoute=actualRoute.slice(0,vendorStart)+
  '      const page = await customers.searchFirstPage(q);\n      for (const c of page.rows) candidates.push(c);'+actualRoute.slice(vendorEnd);
async function runCustomerRoute({candidate=false,q='Jane Doe',body={data:[]},local=[],dbError=false,upstreamError=false,withPool=true}={}) {
  const calls=[],queries=[];
  const request=async path=>{
    calls.push(path);
    if(upstreamError) throw Error('synthetic unavailable');
    return structuredClone(body);
  };
  const customers=createLightspeedCustomersRead({transport:{request}});
  let handler;
  const router={get(path,fn){assert.equal(path,'/customers/search');handler=fn;}};
  const pool=withPool?{async query(sql,args){queries.push({sql,args:JSON.parse(JSON.stringify(args))});if(dbError)throw Error('synthetic DB unavailable');return {rows:structuredClone(local)};}}:null;
  const fetch=async url=>{
    assert.equal(candidate,false,'candidate must not call legacy fetch');
    const parsed=new URL(url);
    assert.equal(parsed.host,'fixture.retail.lightspeed.app');
    const response=await request(parsed.pathname+parsed.search);
    return {ok:true,async text(){return JSON.stringify(response);}};
  };
  runInNewContext(candidate?candidateRoute:actualRoute,{router,pool,customers,fetch,URLSearchParams,lightspeedDomain:'fixture',lightspeedToken:'synthetic',lightspeedHeaders:()=>({})},{timeout:1000});
  let status=200,result;
  const res={status(value){status=value;return this;},json(value){result=JSON.parse(JSON.stringify(value));return this;}};
  await handler({query:{q}},res);
  return {status,result,calls,queries};
}
test('actual Special Orders GET handler and candidate substitution preserve legacy results and local enrichment',async()=>{
  const body={data:[{id:'002',first_name:'Jane',custom:'retained'},{id:'001',email:'j@example.test'}],links:{next:'?offset=20'}};
  const local=[{lightspeed_customer_id:'002',id:'local-2',discord_handle:'fixture',phone:'5550101',notes:'note'}];
  for(const q of [' Jane Doe ','j@example.test','319-555-0101']) {
    const original=await runCustomerRoute({q,body,local});
    const proposed=await runCustomerRoute({candidate:true,q,body,local});
    assert.deepEqual(proposed,original);
    assert.equal(proposed.calls.length,1);
    assert.deepEqual(proposed.queries[0].args,[['002','001']]);
    assert.equal(proposed.result[0].local_customer_id,'local-2');
    assert.equal(proposed.result[0].custom,'retained');
    assert.deepEqual(proposed.result[1],body.data[1]);
  }
});
test('route substitution preserves blank queries, empty results, absent pool and synthetic dependency errors',async()=>{
  for(const options of [{q:'  '},{body:{data:[]}},{withPool:false,body:{data:[{id:'01'}]}},{dbError:true,body:{data:[{id:'01'}]}},{upstreamError:true}]) {
    assert.deepEqual(await runCustomerRoute({...options,candidate:true}),await runCustomerRoute(options));
  }
  const blank=await runCustomerRoute({q:' ',candidate:true});
  assert.deepEqual(blank.calls,[]);assert.deepEqual(blank.queries,[]);
});
test('malformed vendor envelope is deliberately rejected rather than treated as empty',async()=>{
  const body={unexpected:[]};
  const original=await runCustomerRoute({body});
  const proposed=await runCustomerRoute({body,candidate:true});
  assert.equal(original.status,200);assert.deepEqual(original.result,[]);
  assert.equal(proposed.status,502);assert.equal(proposed.queries.length,0);
});
