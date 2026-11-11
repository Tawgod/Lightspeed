import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isKnownPermission } from '../services/security/adminPermissionCatalog.js';
import { CORE_OPERATIONS_ROUTE_INVENTORY, coreOperationsRouteKey } from '../services/security/coreOperationsRouteInventory.js';

const files = ['special-orders.js', 'routes/specialOrderProducts.js'];
function currentRoutes(source) {
  const text = readFileSync(new URL('../' + source, import.meta.url), 'utf8');
  return [...text.matchAll(/\brouter\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)]
    .map(([,method,path]) => [source,method.toUpperCase(),path].join(' '));
}
const keyOf = (method, path, source = 'special-orders.js') => [source,method,path].join(' ');
const routeMap = new Map(CORE_OPERATIONS_ROUTE_INVENTORY.map(route =>
  [coreOperationsRouteKey(route), route]));

test('the inventory names EVERY currently mounted Special Orders and product-subrouter HTTP route exactly once', () => {
  const expected = files.flatMap(currentRoutes).sort();
  const actual = [...routeMap.keys()].sort();
  assert.equal(CORE_OPERATIONS_ROUTE_INVENTORY.length, expected.length);
  assert.equal(routeMap.size, expected.length, 'duplicate route in inventory');
  assert.deepEqual(actual, expected, 'source route added/removed/renamed: review auth classification');
  // This is a source-derived checkpoint, not a permanent hard-coded count.
  assert.equal(expected.length, 87);
});

test('all proposed operation names exist, but NONE of the inventory can be used as an automatic permission grant', () => {
  for (const route of CORE_OPERATIONS_ROUTE_INVENTORY) {
    assert.ok(Object.isFrozen(route));
    assert.equal(route.review, 'pending');
    assert.ok(['staff-candidate','service-or-staff-unknown','staff-or-service-unknown','public-existing','authenticated-existing']
      .includes(route.caller), coreOperationsRouteKey(route));
    assert.ok(typeof route.kind === 'string' && route.kind.length > 3);
    if (route.operation !== null) {
      assert.equal(isKnownPermission(route.operation), true, coreOperationsRouteKey(route));
    } else {
      assert.ok(['public-health','session-check','service-or-automation-review','vendor-write']
        .includes(route.kind), coreOperationsRouteKey(route));
    }
  }
});

test('public and authentication health are explicit and do not implicitly grant all tools', () => {
  assert.equal(routeMap.get(keyOf('GET','/health')).kind,'public-health');
  assert.equal(routeMap.get(keyOf('GET','/health')).operation,null);
  assert.equal(routeMap.get(keyOf('GET','/auth-check')).kind,'session-check');
  assert.ok(!CORE_OPERATIONS_ROUTE_INVENTORY.some(r=>
    r.kind==='public-health' && r.path!=='/health'));
});

test('Discord/batch workers must be reviewed for a separate service identity, not assigned browser staff grants', () => {
  const examples = [
    ['POST','/preorders/gw/discord-reaction'],
    ['POST','/preorders/gw/campaigns/:id/auto-submit-failure'],
    ['GET','/notifications/discord-delivery'],
    ['POST','/notifications/:id/claim-discord'],
    ['POST','/notifications/:id/complete-discord'],
    ['POST','/products/registry-upsert'],
    ['POST','/reconcile/products','routes/specialOrderProducts.js'],
    ['POST','/customers/:id/purchase-metrics']
  ];
  for (const [method,path,source] of examples) {
    const route = routeMap.get(keyOf(method,path,source));
    assert.ok(route, path);
    assert.equal(route.kind, 'service-or-automation-review');
    assert.equal(route.caller, 'service-or-staff-unknown');
    assert.equal(route.operation, null);
  }
});

test('live Lightspeed writes and read-via-POST actions cannot be incorrectly inferred from HTTP verbs', () => {
  for (const [method,path,source] of [
    ['POST','/supplier-orders/:id/push-lightspeed','special-orders.js'],
    ['POST','/customers/create-lightspeed','special-orders.js'],
    ['POST','/products/create-lightspeed','routes/specialOrderProducts.js']
  ]) {
    assert.equal(routeMap.get(keyOf(method,path,source)).kind,'vendor-write');
  }
  for (const [method,path,source] of [
    ['POST','/address/verify-usps','special-orders.js'],
    ['POST','/products/match-local','routes/specialOrderProducts.js'],
    ['POST','/products/match-remote','routes/specialOrderProducts.js'],
    ['POST','/preorders/gw/scrape-preview','special-orders.js']
  ]) {
    assert.equal(routeMap.get(keyOf(method,path,source)).kind,'read-via-post');
  }
});
