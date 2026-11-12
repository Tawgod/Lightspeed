import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CORE_OPERATIONS_ROUTE_INVENTORY,coreOperationsRouteKey}
  from '../services/security/coreOperationsRouteInventory.js';
import {CORE_OPERATIONS_PROVISIONAL_SCOPES,reviewProvisionalScopes}
  from '../services/security/coreOperationsProvisionalScopes.js';
import {STAFF_ACCESS_ACTIONS,createStaffAccessBaseline}
  from '../services/security/staffAccessBaseline.js';
import {TOOL_OPERATIONS} from '../services/security/adminPermissionCatalog.js';
import {createCoreOperationsRouteAdmission}
  from '../services/security/coreOperationsRouteAdmission.js';

const routine=['special-orders.notes.write','special-orders.routing.write','ordering.draft.write',
  'ordering.draft.write','special-orders.notifications.stage',
  'ordering.suppliers.sync','ordering.suppliers.sync',
  'ordering.context.refresh','customers.profile.write'];
const now=Date.parse('2026-11-11T21:45:00Z');
const reject=error=>error?.status===403 && error?.code==='HC_CORE_OPERATIONS_FORBIDDEN';
function request(method,path,proof='none'){
  const headers={'authorization':'Bearer verified-employee','x-fixture-proof':proof,
    'x-hc-role':'owner','x-hobby-corner-key':'unsafe-old-key'};
  return {method,path,headers,body:{role:'owner',employee:'42'},
    get(name){return headers[String(name).toLowerCase()];}};
}
function staff(grants) {
  return createStaffAccessBaseline({
    now:()=>now,
    verifyEmployeeSession:async request=>{
      if(request.get('authorization')!=='Bearer verified-employee')throw Error('Unsigned');
      return {id:'42',active:true,clockedIn:false};
    },
    verifyWorkstation:async request=>request.get('x-fixture-proof')==='station'
      ? {verified:true,deviceId:'store-provisioned',expiresAtMs:now+60_000}:null,
    verifyStepUp:async request=>['passkey','totp'].includes(request.get('x-fixture-proof'))
      ? {verified:true,employeeId:'42',method:request.get('x-fixture-proof'),authenticatedAtMs:now-1000}:null,
    checkPermission:async ({identity,operation})=>identity.id==='42'&&grants.has(operation)
  });
}
const approval=scope=>({source:scope.source,method:scope.method,path:scope.path,
  audience:'employee',operation:scope.operation});
const inventory=new Map(CORE_OPERATIONS_ROUTE_INVENTORY.map(x=>[coreOperationsRouteKey(x),x]));

test('every proposed split scope is known, uses an exact existing route, stays PENDING and has no duplicate method/path',()=>{
  assert.ok(Object.isFrozen(CORE_OPERATIONS_PROVISIONAL_SCOPES));
  assert.equal(CORE_OPERATIONS_PROVISIONAL_SCOPES.length,20);
  assert.equal(new Set(CORE_OPERATIONS_PROVISIONAL_SCOPES.map(coreOperationsRouteKey)).size,20);
  const reviews=reviewProvisionalScopes();
  for(const route of reviews){
    assert.ok(Object.isFrozen(route));
    assert.equal(route.review,'pending');
    assert.equal(route.routePresent,true,coreOperationsRouteKey(route));
    assert.equal(route.knownToolOperation,true,route.operation);
    assert.equal(TOOL_OPERATIONS.includes(route.operation),true);
    assert.ok(inventory.get(coreOperationsRouteKey(route))?.review==='pending');
    assert.equal(STAFF_ACCESS_ACTIONS[route.operation]?.assurance,route.assurance,route.operation);
    assert.ok(typeof route.rationale==='string'&&route.rationale.length>20);
  }
});

test('only audited local notes/routing/unsent supplier draft scope is a routine provisional action',()=>{
  assert.deepEqual(CORE_OPERATIONS_PROVISIONAL_SCOPES
    .filter(x=>x.assurance==='staff-device').map(x=>x.operation).sort(),[...routine].sort());
  const status=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.path==='/items/:id/status');
  assert.equal(status.assurance,'step-up'); // can CANCEL/COMPLETE and suppress notifications
  for(const path of ['/supplier-orders/:id/push-lightspeed','/customers/create-lightspeed',
    '/products/create-lightspeed','/preorders/gw/campaigns/:id/discord-publish',
    '/notifications/:id/review','/preorders/products/:id/allocate']){
    assert.ok(CORE_OPERATIONS_PROVISIONAL_SCOPES.some(x=>x.path===path&&x.assurance==='step-up'),path);
  }
});

test('even proposed scopes allow nothing unless the server explicitly approves the exact route',async()=>{
  const gate=createCoreOperationsRouteAdmission({staffAccess:staff(new Set(TOOL_OPERATIONS))});
  for(const [method,path] of [['PATCH','/items/44/notes'],['POST','/supplier-orders'],
    ['POST','/customers/create-lightspeed']]){
    await assert.rejects(gate.authorize({request:request(method,path,'passkey')}),reject);
  }
});

test('routine granted notes do not imply routing, status, live vendor writes or other scope',async()=>{
  const notes=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.operation==='special-orders.notes.write');
  const routing=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.operation==='special-orders.routing.write');
  const vendor=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.operation==='ordering.vendor.push');
  const status=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.operation==='special-orders.status.write');
  const gate=createCoreOperationsRouteAdmission({
    approvedRoutes:[notes,routing,status,vendor].map(approval),
    staffAccess:staff(new Set([notes.operation]))
  });
  const result=await gate.authorize({request:request('PATCH','/items/44/notes','station')});
  assert.equal(result.operation,notes.operation);
  for(const [method,path,proof] of [
    ['PATCH','/items/44/routing','station'],
    ['PATCH','/items/44/status','passkey'],
    ['POST','/supplier-orders/8/push-lightspeed','passkey']
  ]) await assert.rejects(gate.authorize({request:request(method,path,proof)}),reject);
});

test('strong-only approved operations demand fresh passkey and exact grant; TOTP/station cannot write',async()=>{
  const vendor=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.operation==='ordering.vendor.push');
  const receive=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.operation==='ordering.receive');
  const gate=createCoreOperationsRouteAdmission({
    approvedRoutes:[vendor,receive].map(approval),
    staffAccess:staff(new Set([vendor.operation]))
  });
  for(const proof of ['station','totp','none']){
    await assert.rejects(gate.authorize({request:request('POST',
      '/supplier-orders/8/push-lightspeed',proof)}),reject);
  }
  const result=await gate.authorize({request:request('POST','/supplier-orders/8/push-lightspeed','passkey')});
  assert.equal(result.operation,vendor.operation);
  await assert.rejects(gate.authorize({request:request('POST',
    '/supplier-orders/8/receive','passkey')}),reject);
});

test('deployed service and Owner-only admin permissions cannot be snuck into a store route approval',()=>{
  assert.throws(()=>createCoreOperationsRouteAdmission({
    approvedRoutes:[{source:'special-orders.js',method:'GET',path:'/orders',
      audience:'employee',operation:'admin.delegation.manage'}]
  }),TypeError);
});


test('cache-refreshing GET routes require exact sync grants instead of generic read grants',async()=>{
  const selected=CORE_OPERATIONS_PROVISIONAL_SCOPES.filter(x=>[
    '/suppliers','/products/:id/recommended-suppliers','/ordering/lightspeed-context'
  ].includes(x.path));
  assert.equal(selected.length,3);
  const approved=selected.map(approval);
  const generic=createCoreOperationsRouteAdmission({
    approvedRoutes:approved,
    staffAccess:staff(new Set(['ordering.read','products.read']))
  });
  for(const [method,path] of [
    ['GET','/suppliers'],['GET','/products/9/recommended-suppliers'],['GET','/ordering/lightspeed-context']
  ]) await assert.rejects(generic.authorize({request:request(method,path,'station')}),reject);

  const exact=createCoreOperationsRouteAdmission({
    approvedRoutes:approved,
    staffAccess:staff(new Set(['ordering.suppliers.sync','ordering.context.refresh']))
  });
  assert.equal((await exact.authorize({request:request('GET','/suppliers','station')})).operation,'ordering.suppliers.sync');
  assert.equal((await exact.authorize({request:request('GET','/products/9/recommended-suppliers','station')})).operation,'ordering.suppliers.sync');
  assert.equal((await exact.authorize({request:request('GET','/ordering/lightspeed-context','station')})).operation,'ordering.context.refresh');
});


test('only the row-locked supplier-order add-items route joins routine draft editing',()=>{
  const scope=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.path==='/supplier-orders/:id/items');
  assert.ok(scope);
  assert.equal(scope.operation,'ordering.draft.write');
  assert.equal(scope.assurance,'staff-device');
  const source=readFileSync(new URL('../special-orders.js', import.meta.url),'utf8');
  const start=source.indexOf("router.post('/supplier-orders/:id/items'");
  const end=source.indexOf("router.get('/supplier-orders/:id'",start);
  assert.ok(start>=0&&end>start);
  const handler=source.slice(start,end);
  assert.match(handler,/SELECT \* FROM supplier_orders WHERE id=\$1 FOR UPDATE/);
  assert.match(handler,/status\)\.toUpperCase\(\)!=='DRAFT'/);
  for(const path of ['/supplier-orders/:id','/supplier-order-items/:id']){
    const candidate=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.path===path);
    assert.equal(candidate,undefined,path+' remains conservative pending locked-state review');
  }
});


test('notification staging is routine and cannot authorize the separate delivery-queue approval',async()=>{
  const stage=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.path==='/items/:id/notifications/ready');
  const send=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.path==='/notifications/:id/review');
  assert.ok(stage&&send);
  assert.equal(stage.operation,'special-orders.notifications.stage');
  assert.equal(stage.assurance,'staff-device');
  assert.equal(send.operation,'special-orders.notifications.send');
  assert.equal(send.assurance,'step-up');

  const onlyStage=createCoreOperationsRouteAdmission({
    approvedRoutes:[stage,send].map(approval),
    staffAccess:staff(new Set([stage.operation]))
  });
  const staged=await onlyStage.authorize({request:request('POST','/items/44/notifications/ready','station')});
  assert.equal(staged.operation,stage.operation);
  await assert.rejects(onlyStage.authorize({request:request('PATCH','/notifications/9/review','passkey')}),reject);

  const onlySend=createCoreOperationsRouteAdmission({
    approvedRoutes:[stage,send].map(approval),
    staffAccess:staff(new Set([send.operation]))
  });
  await assert.rejects(onlySend.authorize({request:request('POST','/items/44/notifications/ready','passkey')}),reject);
  assert.equal((await onlySend.authorize({request:request('PATCH','/notifications/9/review','passkey')})).operation,send.operation);
});
