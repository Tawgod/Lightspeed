import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaffAccessBaseline, STAFF_ACCESS_ACTIONS } from '../services/security/staffAccessBaseline.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const session = async request => {
  if (request.token !== 'signed-session') throw Error('Session not valid.');
  return { id: 17, active: true, role: request.body?.role || 'staff' };
};
const validDevice = async () => ({
  verified: true, deviceId: 'registered-station', expiresAtMs: NOW + 60000
});
const strongProof = async () => ({
  verified: true, employeeId: '17', method: 'passkey', authenticatedAtMs: NOW - 1000
});
const permit = async () => true;
const req = { token: 'signed-session', body: { role: 'admin', trustedDevice: true }, headers: {
  'x-trusted-device': 'true', 'x-employee-role': 'admin', 'x-step-up': 'true'
} };
const denied = err => err?.code === 'HC_STAFF_ACCESS_DENIED' && err.status === 403;

test('baseline never accepts a bare employee name, PIN, role, or client trust header', async () => {
  const baseline = createStaffAccessBaseline({ verifyEmployeeSession: session,
    checkPermission: permit, now: () => NOW });
  assert.ok(Object.isFrozen(STAFF_ACCESS_ACTIONS));
  for (const action of ['timeclock.clock', 'tools.read', 'products.write']) {
    await assert.rejects(baseline.authorize({ request: req, action }), denied);
  }
  await assert.rejects(baseline.authorize({ request: { pin: '1234', name: 'Staff' },
    action: 'timeclock.clock' }), denied);
  await assert.rejects(baseline.authorize({ request: req, action: 'unknown.admin' }), denied);
});

test('registered station proof allows normal clocking and staging, but not privileged Lightspeed writes', async () => {
  const baseline = createStaffAccessBaseline({
    verifyEmployeeSession: session, verifyWorkstation: validDevice,
    checkPermission: permit, now: () => NOW
  });
  const clock = await baseline.authorize({ request: req, action: 'timeclock.clock' });
  assert.equal(clock.employeeId, '17');
  assert.equal(clock.assurance, 'workstation');
  const stage = await baseline.authorize({ request: req, action: 'tools.stage' });
  assert.equal(stage.operation, 'tools.stage');
  await assert.rejects(baseline.authorize({ request: req, action: 'inventory.adjust' }), denied);
  await assert.rejects(baseline.authorize({ request: req, action: 'staff.permissions' }), denied);
});

test('fresh independent passkey proof and exact backend grant permit a protected operation', async () => {
  let granted;
  const baseline = createStaffAccessBaseline({
    verifyEmployeeSession: session, verifyStepUp: strongProof, now: () => NOW,
    checkPermission: async operation => {
      granted = operation;
      return operation.operation === 'purchase-orders.write';
    }
  });
  const value = await baseline.authorize({ request: req, action: 'purchase-orders.write' });
  assert.equal(value.assurance, 'step-up');
  assert.equal(value.employeeId, '17');
  assert.equal(granted.identity.id, '17');
  assert.equal(Object.hasOwn(granted.identity, 'role'), false);
  await assert.rejects(baseline.authorize({ request: req, action: 'products.write' }), denied);
});

test('expired, unbound, unknown or claimed second factors all fail closed', async () => {
  const invalid = [
    { ...await strongProof(), authenticatedAtMs: NOW - 360000 },
    { ...await strongProof(), authenticatedAtMs: NOW + 1000 },
    { ...await strongProof(), employeeId: '18' },
    { ...await strongProof(), method: 'pin' },
    { ...await strongProof(), verified: false },
    { ...await strongProof(), authenticatedAtMs: 'just-now' }
  ];
  for (const data of invalid) {
    const baseline = createStaffAccessBaseline({
      verifyEmployeeSession: session,
      verifyStepUp: async () => data,
      checkPermission: permit, now: () => NOW
    });
    await assert.rejects(baseline.authorize({ request: req, action: 'products.write' }), denied);
  }
});

test('expired station proof, missing grant, revoked employee and failed backends deny access', async () => {
  const scenarios = [
    { verifyWorkstation: async () => ({ ...await validDevice(), expiresAtMs: NOW - 1 }) },
    { verifyWorkstation: async () => ({ ...await validDevice(), expiresAtMs: NOW + 13 * 3600000 }) },
    { verifyWorkstation: async () => ({ verified: true, expiresAtMs: NOW + 30000 }) },
    { verifyWorkstation: async () => { throw Error('device service offline'); } },
    { verifyWorkstation: validDevice, checkPermission: async () => false },
    { verifyWorkstation: validDevice, checkPermission: async () => { throw Error('DB unavailable'); } },
    { verifyWorkstation: validDevice, verifyEmployeeSession: async () => ({ id: 17, active: false }) }
  ];
  for (const options of scenarios) {
    const baseline = createStaffAccessBaseline({
      verifyEmployeeSession: session, checkPermission: permit,
      now: () => NOW, ...options
    });
    await assert.rejects(baseline.authorize({ request: req, action: 'tools.read' }), denied);
  }
});

test('baseline requires explicit verified-session and permission adapters', () => {
  assert.throws(() => createStaffAccessBaseline(), TypeError);
  assert.throws(() => createStaffAccessBaseline({ verifyEmployeeSession: session }), TypeError);
  assert.throws(() => createStaffAccessBaseline({
    verifyEmployeeSession: session, checkPermission: permit, verifyWorkstation: true
  }), TypeError);
});
