import test from 'node:test';
import assert from 'node:assert/strict';
import {creditEligibility,HOLD_MS} from '../services/consignmentCreditEligibility.js';
const sale={sale_id:'sale-1',item_id:'UG-100001',sold_at:'2026-10-20T10:00:00.000Z',price_cents:1999,reconciliation_complete:true};
test('exactly three full days required and stable idempotency identity',()=>{
 const early=creditEligibility({sale,now:new Date(new Date(sale.sold_at).getTime()+HOLD_MS-1)});
 assert.equal(early.eligible,false);assert.equal(early.reason,'HOLD_PERIOD');
 const ready=creditEligibility({sale,now:'2026-10-23T10:00:00.000Z'});
 assert.equal(ready.eligible,true);assert.equal(ready.creditCents,1599);
 assert.equal(ready.idempotencyKey,'consignment-credit:UG-100001:sale-1');
});
test('sale reversal, unresolved return and unknown reconciliation block credit',()=>{
 const now='2026-10-27T10:00:00Z';
 assert.equal(creditEligibility({sale,returns:[{sale_id:'sale-1',item_id:'UG-100001',status:'RETURNED'}],now}).reason,'SALE_REVERSED');
 assert.equal(creditEligibility({sale,returns:[{sale_id:'sale-1',item_id:'UG-100001',status:'PENDING'}],now}).reason,'RETURN_RECONCILIATION_PENDING');
 assert.equal(creditEligibility({sale:{...sale,reconciliation_complete:false},now}).reason,'SALE_RECONCILIATION_UNVERIFIED');
});
