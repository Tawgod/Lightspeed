import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCustomerIdentity,createCustomerIdentityRead} from '../services/lightspeed/customerIdentityEvidence.js';
import {createLightspeedCustomersRead} from '../services/lightspeed/customers.js';
import {createCoreReadExecutor} from '../services/lightspeed/coreReadContract.js';
const observedAt='2026-11-24T12:00:00Z';
const link=(extra={})=>({customerId:'001',provider:'discord',externalId:'private-id',status:'verified',observedAt,...extra});
const consent=(extra={})=>({customerId:'001',channel:'email',status:'opt-in',evidenceId:'private-proof',observedAt,...extra});
const project=(links=[],consents=[])=>projectCustomerIdentity({customerId:'001',links,consents});
test('missing evidence is unknown and cannot authorize sending',()=>{
 const out=project();
 assert.ok(out.links.every(x=>x.status==='unknown'));
 assert.ok(out.consents.every(x=>x.status==='unknown'));
 assert.equal(out.canSend,false);
});
test('identity and consent evidence omit external identifiers and private evidence',()=>{
 const out=project([link()],[consent()]);
 assert.equal(out.links[0].status,'verified');
 assert.equal(out.links[0].requiresReview,true);
 assert.equal(out.consents[0].status,'opt-in');
 assert.equal(out.canSend,false);
 assert.ok(!JSON.stringify(out).includes('private'));
});
test('multiple accounts or contradictory states require review; opt-out dominates',()=>{
 const out=project([link(),link({externalId:'other'}),link({status:'revoked'})],[consent(),consent({status:'opt-out'})]);
 assert.equal(out.links[0].status,'conflicting');
 assert.deepEqual(out.consents[0],{channel:'email',status:'opt-out',conflicting:true});
 assert.equal(out.canSend,false);
});
test('cross-customer, invalid dates and invalid evidence reject',()=>{
 for(const row of [link({customerId:'1'}),link({externalId:1}),link({observedAt:'2026-02-30T12:00:00Z'}),link({provider:'staff'})]){
  assert.throws(()=>project([row]),{code:'LIGHTSPEED_INCOMPLETE_READ'});
 }
 assert.throws(()=>project([],[consent({evidenceId:''})]),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
test('Core admission precedes all evidence reads and correlation propagates',async()=>{
 const calls=[];
 const customers=createLightspeedCustomersRead({transport:{async request(path,opts){calls.push([path,opts]);return {data:{id:'001',email:'private'}};}}});
 const reader=createCustomerIdentityRead({customers,readLinks:async(id,opts)=>{calls.push(['links',opts]);return [link()];},readConsents:async(id,opts)=>{calls.push(['consents',opts]);return [consent()];}});
 const run=authorizeRead=>createCoreReadExecutor({authorizeRead,environment:'test'})({operation:'customers.identity.read',context:{},read:opts=>reader.get('001',opts)});
 assert.equal((await run(async()=>({allowed:true}))).status,403);
 assert.equal(calls.length,0);
 const out=await run(async()=>true);
 assert.equal(out.status,200);
 assert.equal(out.body.version,'core.v1');
 assert.equal(calls.length,3);
 for(const [,opts] of calls)assert.equal(opts.correlationId,out.body.correlationId);
 assert.ok(!JSON.stringify(out).includes('private'));
});
test('upstream failure is sanitized by Core; mismatched customer blocks evidence readers',async()=>{
 let count=0;
 const reader=createCustomerIdentityRead({customers:{get:async()=>({data:{id:'002'}})},readLinks:async()=>{count++;return [];},readConsents:async()=>{count++;return [];}});
 const execute=createCoreReadExecutor({authorizeRead:async()=>true,environment:'test'});
 const out=await execute({operation:'customers.identity.read',context:{},read:opts=>reader.get('001',opts)});
 assert.equal(out.status,502);assert.equal(count,0);
 const errorReader=createCustomerIdentityRead({customers:{get:async()=>({data:{id:'001'}})},readLinks:async()=>{throw Error('private secret');},readConsents:async()=>[]});
 const failure=await execute({operation:'customers.identity.read',context:{},read:opts=>errorReader.get('001',opts)});
 assert.equal(failure.status,503);assert.ok(!JSON.stringify(failure).includes('private'));
});
test('customer search modes propagate trace without changing existing shape',async()=>{
 const calls=[];
 const customers=createLightspeedCustomersRead({transport:{async request(path,opts){calls.push([path,opts]);return {data:path.includes('offset=20')?[]:Array.from({length:20},(_,i)=>({id:String(i)}))};}}});
 assert.equal((await customers.searchFirstPage('Jane',{correlationId:'trace'})).rows.length,20);
 assert.equal((await customers.search('Jane',{correlationId:'trace'})).length,20);
 assert.equal(calls.length,3);
 assert.ok(calls.every(([,opts])=>opts.correlationId==='trace'));
});
