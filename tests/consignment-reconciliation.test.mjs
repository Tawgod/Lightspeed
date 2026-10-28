import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileConsignmentEvents} from '../services/consignmentSaleReconciliation.js';
import {creditEligibility} from '../services/consignmentCreditEligibility.js';
const item={consignment_code:'UG-000123'};
const sale={event_id:'sale-event-1',type:'SALE',consignment_code:'UG-000123',sale_id:'sale-1',sold_at:'2026-10-20T10:00:00Z',price_cents:2500};
test('duplicate deliveries do not duplicate sale or credit identity',()=>{
 const r=reconcileConsignmentEvents({item,events:[sale,sale]});
 assert.equal(r.verified,true);assert.equal(r.eventCount,1);
 const credit=creditEligibility({sale:r.sale,returns:r.returns,now:'2026-10-24T10:00:00Z'});
 assert.equal(credit.eligible,true);assert.equal(credit.creditCents,2000);
 assert.equal(credit.idempotencyKey,'consignment-credit:UG-000123:sale-1');
});
test('return, void, multiple sales or foreign sale events fail closed',()=>{
 for(const type of ['RETURN','VOID']){
  const r=reconcileConsignmentEvents({item,events:[sale,{...sale,event_id:'event-2',type}]});
  assert.equal(r.verified,false);assert.equal(r.reason,'SALE_REVERSED');
 }
 assert.equal(reconcileConsignmentEvents({item,events:[sale,{...sale,event_id:'sale-event-2',sale_id:'sale-2'}]}).reason,'MULTIPLE_SALES');
 assert.equal(reconcileConsignmentEvents({item,events:[sale,{...sale,event_id:'event-3',type:'RETURN',sale_id:'other'}]}).reason,'UNMATCHED_EVENT');
});
test('nonmatching items and missing evidence do not establish a sale',()=>{
 const r=reconcileConsignmentEvents({item,events:[{...sale,consignment_code:'UG-000999'}]});
 assert.equal(r.verified,false);assert.equal(r.reason,'SALE_NOT_FOUND');
 assert.throws(()=>reconcileConsignmentEvents({item,events:[{...sale,event_id:null}]}),/Unverified/);
});
