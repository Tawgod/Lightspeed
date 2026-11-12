import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CORE_OPERATIONS_SERVICE_PROPOSALS,reviewCoreOperationsServiceProposals}
  from '../services/security/coreOperationsServiceProposals.js';
import {coreOperationsRouteKey}
  from '../services/security/coreOperationsRouteInventory.js';
import {createCoreOperationsRouteAdmission}
  from '../services/security/coreOperationsRouteAdmission.js';

const reject=error=>error?.status===403 && error?.code==='HC_CORE_OPERATIONS_FORBIDDEN';

function request(method,path,service='discord-delivery'){
  const headers={'x-fixture-service':service,'x-hobby-corner-key':'legacy-key-not-proof'};
  return {method,path,headers,body:{role:'owner'},
    get(name){return headers[String(name).toLowerCase()];}};
}

test('service proposals are exact existing review-pending service/automation routes',()=>{
  assert.ok(Object.isFrozen(CORE_OPERATIONS_SERVICE_PROPOSALS));
  assert.equal(CORE_OPERATIONS_SERVICE_PROPOSALS.length,7);
  assert.equal(new Set(CORE_OPERATIONS_SERVICE_PROPOSALS.map(coreOperationsRouteKey)).size,7);
  assert.equal(new Set(CORE_OPERATIONS_SERVICE_PROPOSALS.map(x=>x.operation)).size,7);
  for(const route of reviewCoreOperationsServiceProposals()){
    assert.ok(Object.isFrozen(route));
    assert.equal(route.review,'pending');
    assert.equal(route.audience,'service');
    assert.equal(route.routePresent,true,coreOperationsRouteKey(route));
    assert.equal(route.inventoryKind,'service-or-automation-review',coreOperationsRouteKey(route));
    assert.equal(route.inventoryCaller,'service-or-staff-unknown',coreOperationsRouteKey(route));
    assert.match(route.operation,/^service\.[a-z][a-z0-9.-]{2,95}$/);
    assert.ok(route.rationale.length>30);
  }
});

test('known employee/browser mixed routes are intentionally absent from service-only proposals',()=>{
  const keys=new Set(CORE_OPERATIONS_SERVICE_PROPOSALS.map(coreOperationsRouteKey));
  for(const key of [
    'special-orders.js GET /preorders/discord-watch',
    'special-orders.js GET /notifications/delivery-queue',
    'routes/specialOrderProducts.js POST /reconcile/products'
  ]) assert.equal(keys.has(key),false,key);
});

test('service proposals authorize nothing unless explicitly supplied to the backend gate',async()=>{
  const proposal=CORE_OPERATIONS_SERVICE_PROPOSALS.find(
    x=>x.operation==='service.notifications.complete-discord'
  );
  const verifyServiceRequest=async req=>req.get('x-fixture-service')==='discord-delivery'
    ? {type:'service',id:'discord-delivery',active:true}:null;
  const checkServiceGrant=async ()=>true;
  const closed=createCoreOperationsRouteAdmission({verifyServiceRequest,checkServiceGrant});
  await assert.rejects(
    closed.authorize({request:request('POST','/notifications/12/complete-discord')}),
    reject
  );

  const allowed=createCoreOperationsRouteAdmission({
    approvedRoutes:[proposal],verifyServiceRequest,
    checkServiceGrant:async ({identity,operation})=>
      identity.id==='discord-delivery' && operation===proposal.operation
  });
  const admitted=await allowed.authorize({
    request:request('POST','/notifications/12/complete-discord')
  });
  assert.deepEqual(admitted,{
    principal:'service',identityId:'discord-delivery',
    operation:'service.notifications.complete-discord',assurance:'scoped-service'
  });
});

test('service grants remain exact across claim, complete and unrelated worker operations',async()=>{
  const routes=CORE_OPERATIONS_SERVICE_PROPOSALS.filter(x=>
    x.operation.startsWith('service.notifications.')
  );
  const gate=createCoreOperationsRouteAdmission({
    approvedRoutes:routes,
    verifyServiceRequest:async req=>req.get('x-fixture-service')==='discord-delivery'
      ? {type:'service',id:'discord-delivery',active:true}:null,
    checkServiceGrant:async ({operation})=>operation==='service.notifications.claim-discord'
  });
  const claim=await gate.authorize({
    request:request('POST','/notifications/12/claim-discord')
  });
  assert.equal(claim.operation,'service.notifications.claim-discord');
  await assert.rejects(
    gate.authorize({request:request('POST','/notifications/12/complete-discord')}),
    reject
  );
  await assert.rejects(
    gate.authorize({request:request('GET','/notifications/discord-delivery')}),
    reject
  );
});


test('GW mark-submitted SQL pins quantity parameter type before numeric multiplication',()=>{
  const source=readFileSync(new URL('../special-orders.js',import.meta.url),'utf8');
  assert.ok(source.includes('submitted_quantity=$1::integer,ordered_quantity=$1::integer'));
  assert.ok(source.includes('ELSE $1::integer*msrp END'));
  assert.equal(source.includes('ELSE $1*msrp END'),false);
});
