import test from 'node:test';
import assert from 'node:assert/strict';
import { createLightspeedPermissionChecker, createHobbyCornerStaffLightspeedPolicy, LIGHTSPEED_OPERATION_ACCESS } from '../services/lightspeed/permissions.js';
import { employeeRequestPrincipal } from '../services/lightspeed/staffAdapter.js';

const employee = { id: 'E001', active: true, canLookup: true, canApprove: true, role: 'owner' };
const input = (operation, mode = 'read', identity = employee, type = 'employee') =>
  ({ identity, type, operation, mode, environment: 'production' });

test('operation matrix includes only explicit authorized operation names', () => {
  const expectedReads = ['customers.search','products.exact','inventory.read',
    'purchase-orders.read','sales.read','fulfillments.read','store-credit.read'];
  for (const name of expectedReads) {
    assert.equal(LIGHTSPEED_OPERATION_ACCESS[name].mode, 'read');
  }
  assert.equal(Object.isFrozen(LIGHTSPEED_OPERATION_ACCESS), true);
  assert.equal(LIGHTSPEED_OPERATION_ACCESS['users.delete'], undefined);
  assert.equal(LIGHTSPEED_OPERATION_ACCESS['admin.manage'].mode, 'write');
});

test('verified active employee can use existing lookup privilege but no implicit writes', async () => {
  const check = createLightspeedPermissionChecker();
  for (const name of Object.keys(LIGHTSPEED_OPERATION_ACCESS)) {
    const rule = LIGHTSPEED_OPERATION_ACCESS[name];
    assert.equal(await check(input(name, rule.mode)), rule.mode === 'read', name);
  }
  assert.equal(await check(input('products.create','write', employee)), false);
  assert.equal(await check(input('products.exact','write', employee)), false);
  assert.equal(await check(input('products.create','read', employee)), false);
  assert.equal(await check(input('__proto__','read', employee)), false);
  assert.equal(await check(input('products.unknown','read', employee)), false);
});

test('stale/inactive employees, missing lookup flags and claimed roles fail closed', async () => {
  const check = createLightspeedPermissionChecker();
  assert.equal(await check(input('products.exact','read',{ ...employee, active:false })),false);
  assert.equal(await check(input('products.exact','read',{ ...employee, canLookup:false })),false);
  assert.equal(await check(input('products.exact','read',{ ...employee, canLookup:undefined })),false);
  assert.equal(await check(input('products.exact','read',{ id:'E1',active:true,role:'admin' })),false);
  assert.equal(await check(input('products.exact','read',{ ...employee, active:true },'unknown')),false);
});

test('writes need a separate trusted grant even when Timeclock canApprove=true', async () => {
  let requested = [];
  const check = createLightspeedPermissionChecker({
    employeeWriteGrant: async ({identity,operation,environment}) => {
      requested.push([identity.id,operation,environment]);
      return operation === 'products.update' && identity.id === 'E001' && environment === 'test';
    }
  });
  assert.equal(await check(input('products.create','write')),false);
  assert.equal(await check(input('products.update','write')),false);
  assert.equal(await check({ ...input('products.update','write'), environment:'test' }),true);
  assert.deepEqual(requested.at(-1),['E001','products.update','test']);
  assert.equal(await check(input('products.update','write',{ ...employee,active:false })),false);
});

test('service callers require separately verified exact operation grant', async () => {
  const check = createLightspeedPermissionChecker({
    serviceGrant: async ({identity,operation,mode,environment}) =>
      identity.id==='backend-reader' && operation==='inventory.read' &&
      mode==='read' && environment==='test'
  });
  const service={id:'backend-reader',active:true};
  assert.equal(await check({ ...input('inventory.read','read',service,'service'), environment:'test' }),true);
  assert.equal(await check(input('inventory.read','read',service,'service')),false);
  assert.equal(await check({ ...input('products.create','write',service,'service'), environment:'test' }),false);
  assert.equal(await createLightspeedPermissionChecker()(input('inventory.read','read',service,'service')),false);
});

test('integration adapter uses existing trusted Timeclock verification on each request', async () => {
  const requests = [];
  const policy=createHobbyCornerStaffLightspeedPolicy({
    verifyEmployeeRequest:async request => {
      requests.push(request);
      if(request.get('authorization') !== 'Bearer session-verified')throw new Error('invalid session');
      return {id:'TIME-E1',canLookup:true,canApprove:true,role:null};
    }
  });
  const req={get: header=>header==='authorization'?'Bearer session-verified':''};
  const principal=employeeRequestPrincipal(req);
  assert.equal((await policy.authorize({
    principal,operation:'purchase-orders.read',mode:'read',environment:'production'
  })).identityId,'TIME-E1');
  assert.equal(requests.length,1);
  await assert.rejects(policy.authorize({
    principal,operation:'products.create',mode:'write',environment:'production'
  }),e=>e.code==='LIGHTSPEED_FORBIDDEN');
  const invalid={get:()=> 'Bearer bogus',body:{role:'admin',employeeId:'TIME-E1',canLookup:true}};
  await assert.rejects(policy.authorize({
    principal:employeeRequestPrincipal(invalid),operation:'products.exact',mode:'read',environment:'production'
  }),e=>e.code==='LIGHTSPEED_FORBIDDEN');
  assert.equal(requests.length,2);
});
