import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerSourceM10} from '../services/lightspeed/customerSourceM10.js';
const actor={actorId:'A1',tenantId:'T1'},scope={outlet:'O1',purpose:'order-service'};
const setup=(source=()=>true,disclosure=()=>true,rows=[{id:'002',first_name:'Jane'},{id:'001',first_name:'Jane'}])=>{
 const calls=[],checks=[];
 const api=createCustomerSourceM10({environment:'test',authorizeSource:q=>{checks.push(q);return source(q);},authorizeDisclosure:q=>{checks.push(q);return disclosure(q);},readProjected:q=>{calls.push(q);return rows;}});
 return {api,calls,checks};
};
test('independent source denial prevents retrieval even with disclosure grant',async()=>{
 const f=setup(()=>false);await assert.rejects(f.api.search(actor,'Jane',scope),{code:'CORE_FORBIDDEN'});assert.equal(f.calls.length,0);
});
test('independent disclosure denial after scoped source read returns no partial output',async()=>{
 const f=setup(()=>true,q=>q.resource.id!=='001');await assert.rejects(f.api.search(actor,'Jane',scope),{code:'CORE_FORBIDDEN'});assert.equal(f.calls.length,1);
});
test('ordinary search scope and first-page order remain unchanged',async()=>{
 const f=setup(q=>q.operation==='customers.search',q=>q.operation==='customers.search');
 const result=await f.api.search(actor,'Jane',scope);assert.deepEqual(result.rows.map(r=>r.id),['002','001']);assert.equal(result.complete,false);
 assert.ok(f.checks.every(q=>q.actor.tenantId==='T1'&&q.resource.outlet==='O1'&&q.correlationId===result.correlationId));
});
test('contact match needs independent source and disclosure scope even with minimal output',async()=>{
 const f=setup(()=>true,q=>q.operation!=='customers.contacts.read');
 await assert.rejects(f.api.search(actor,'jane@example.test',scope),{code:'CORE_FORBIDDEN'});assert.equal(f.calls.length,1);
});
test('explicit field selection preserves ordinary authorized notes and contact access',async()=>{
 const f=setup(()=>true,()=>true,[{id:'001',email:'fixture@example.test',notes:'fixture note'}]);
 const result=await f.api.search(actor,'Jane',{...scope,requestedFields:['id','email','notes']});
 assert.equal(result.rows[0].notes,'fixture note');assert.deepEqual(f.calls[0].fields,['id','email','notes']);
});
test('unavailable or nonboolean disclosure denies; overbroad source rejects',async()=>{
 for(const decision of [()=>({allowed:true}),()=>{throw Error('offline');}]){
  const f=setup(()=>true,decision);await assert.rejects(f.api.search(actor,'Jane',scope),{code:'CORE_FORBIDDEN'});
 }
 const f=setup(()=>true,()=>true,[{id:'001',notes:'unexpected'}]);await assert.rejects(f.api.search(actor,'Jane',scope),{code:'LIGHTSPEED_INCOMPLETE_READ'});
});
