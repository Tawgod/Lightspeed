import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerSalesEvidence} from '../services/lightspeed/customerSalesEvidence.js';
import {createLightspeedCustomersRead} from '../services/lightspeed/customers.js';
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
