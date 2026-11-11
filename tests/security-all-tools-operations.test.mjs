import test from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_ACCESS_ACTIONS, createStaffAccessBaseline } from '../services/security/staffAccessBaseline.js';
import { TOOL_OPERATIONS } from '../services/security/adminPermissionCatalog.js';

const NOW = Date.parse('2026-11-11T15:00:00Z');
const request = {
  body: { role: 'owner', trustedDevice: true },
  headers: { 'x-hc-role': 'owner', 'x-verified-device': 'true', 'x-step-up': 'passkey' }
};
const routine = new Set([
  'products.read', 'products.draft',
  'scanner.lookup', 'scanner.stage', 'scanner.approve',
  'purchase-orders.read', 'purchase-orders.draft',
  'inventory.read', 'sales.read', 'store-credit.read',
  'special-orders.read', 'ordering.read', 'consignment.read',
  'timeclock.self.read', 'timeclock.self.clock'
]);
const denied = error => error?.code === 'HC_STAFF_ACCESS_DENIED' && error.status === 403;

const employee = async () => ({ id: '42', active: true, clockedIn: false });
const registeredStation = async () => ({
  verified: true, deviceId: 'signed-store-station', expiresAtMs: NOW + 60_000
});
const passkey = async () => ({
  verified: true, employeeId: '42', method: 'passkey', authenticatedAtMs: NOW - 1_000
});
const totp = async () => ({
  verified: true, employeeId: '42', method: 'totp', authenticatedAtMs: NOW - 1_000
});

function access({ verifyWorkstation, verifyStepUp, operations = new Set(TOOL_OPERATIONS), verifyEmployeeSession = employee } = {}) {
  return createStaffAccessBaseline({
    now: () => NOW, verifyEmployeeSession, verifyWorkstation, verifyStepUp,
    checkPermission: async ({ identity, operation }) =>
      identity.id === '42' && operations.has(operation)
  });
}

test('every known tool operation is covered by the SAME frozen staff access policy', () => {
  assert.ok(Object.isFrozen(STAFF_ACCESS_ACTIONS));
  assert.equal(new Set(TOOL_OPERATIONS).size, TOOL_OPERATIONS.length);
  for (const operation of TOOL_OPERATIONS) {
    const descriptor = STAFF_ACCESS_ACTIONS[operation];
    assert.ok(descriptor, 'missing shared security policy: ' + operation);
    assert.ok(Object.isFrozen(descriptor));
    assert.equal(descriptor.permission, operation);
    assert.equal(descriptor.assurance, routine.has(operation) ? 'staff-device' : 'step-up');
  }
  assert.equal(STAFF_ACCESS_ACTIONS['timeclock.clock'].assurance, 'staff-device');
  assert.equal(STAFF_ACCESS_ACTIONS['staff.permissions'].assurance, 'step-up');
});

test('approved workstation and exact backend grant permit routine reads/drafts and clocking, not high-impact writes', async () => {
  const gate = access({ verifyWorkstation: registeredStation });
  for (const operation of routine) {
    const result = await gate.authorize({ request, action: operation });
    assert.equal(result.operation, operation);
    assert.equal(result.employeeId, '42');
    assert.equal(result.assurance, 'workstation');
  }
  for (const operation of TOOL_OPERATIONS.filter(op => !routine.has(op))) {
    await assert.rejects(gate.authorize({ request, action: operation }), denied, operation);
  }
});

test('recent employee-bound TOTP grants routine access, never a high-impact write', async () => {
  const gate = access({ verifyStepUp: totp });
  for (const operation of routine) {
    const result = await gate.authorize({ request, action: operation });
    assert.equal(result.factorMethod, 'totp');
  }
  for (const operation of TOOL_OPERATIONS.filter(op => !routine.has(op))) {
    await assert.rejects(gate.authorize({ request, action: operation }), denied, operation);
  }
});

test('fresh passkey and each exact server grant are required for every high-impact operation', async () => {
  const privileged = TOOL_OPERATIONS.filter(op => !routine.has(op));
  for (const operation of privileged) {
    const grant = access({ verifyStepUp: passkey, operations: new Set([operation]) });
    const granted = await grant.authorize({ request, action: operation });
    assert.equal(granted.operation, operation);
    assert.equal(granted.factorMethod, 'passkey');
    const other = privileged.find(candidate => candidate !== operation);
    if (other) await assert.rejects(grant.authorize({ request, action: other }), denied);
  }
});

test('claimed Owner roles, unregistered device headers, disabled employee, unknown actions and backend failures deny', async () => {
  const untrusted = access({});
  for (const action of ['scanner.lookup', 'special-orders.read', 'products.create', '__proto__', 'admin.delegation.manage']) {
    await assert.rejects(untrusted.authorize({ request, action }), denied);
  }
  const withoutGrant = access({ verifyStepUp: passkey, operations: new Set() });
  await assert.rejects(withoutGrant.authorize({ request, action: 'special-orders.read' }), denied);
  const inactive = access({ verifyWorkstation: registeredStation, verifyEmployeeSession: async () => ({id: '42', active: false, clockedIn: true}) });
  await assert.rejects(inactive.authorize({ request, action: 'timeclock.self.clock' }), denied);
  const offline = createStaffAccessBaseline({
    now: () => NOW, verifyEmployeeSession: employee,
    verifyWorkstation: registeredStation,
    checkPermission: async () => { throw Error('Grant service unavailable'); }
  });
  await assert.rejects(offline.authorize({ request, action: 'scanner.lookup' }), denied);
});
