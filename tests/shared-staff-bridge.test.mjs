import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaffMfaSessions } from '../services/security/staffMfaSessions.js';
import {
  createStaffBoundSessionAdapter, createStaffSecurityAccessGate
} from '../services/security/staffSecurityBridge.js';

const NOW = Date.parse('2026-11-02T13:00:00Z');
const GENERATION = 'cdd2ad1c-48b4-41d4-84d2-d4e3b030d571';
const SESSION_SECRET = 'test-only-session-mfa-secret-never-for-production-use';
const denied = e => e?.code === 'HC_STAFF_ACCESS_DENIED' && e.status === 403;
const req = (authorization = 'Bearer signed-17') => ({
  get: name => name.toLowerCase() === 'authorization' ? authorization : undefined,
  headers: { 'x-employee-role': 'admin', 'x-verified-device': 'true' },
  body: { role: 'admin', trusted: true }
});
function fixture() {
  let current = NOW;
  let employeeActive = true;
  let factorGeneration = GENERATION;
  const now = () => current;
  const staffAuth = {
    verifyBoundEmployee: async request => {
      if (request.get('authorization') !== 'Bearer signed-17' || !employeeActive)
        throw Error('Invalid Timeclock employee session');
      return {id: '17', employeeId: '17', active: true,
        binding: 'signed-unique-session-jti-17', expiresAtMs: NOW + 60_000};
    }
  };
  const staffSession = createStaffBoundSessionAdapter({ staffAuth, now });
  const totp = {
    verifyCode: async ({ code }) => {
      if (code !== '123456') throw Error('Invalid code');
      return {verified: true, employeeId: '17', method: 'totp',
        authenticatedAtMs: current};
    },
    getActiveGeneration: async () => factorGeneration
  };
  const mfa = createStaffMfaSessions({
    secret: SESSION_SECRET, totp, verifyBaseSession: staffSession.verifyBaseSession, now
  });
  const permissions = new Set(['tools.read', 'tools.stage', 'products.write']);
  function gate(options = {}) {
    return createStaffSecurityAccessGate({
      staffSession, mfa, now,
      checkPermission: async ({operation}) => permissions.has(operation),
      ...options
    });
  }
  return {staffSession, mfa, gate, now,
    expire: () => {current += 301_000;},
    deactivate: () => {employeeActive = false;},
    revoke: () => {factorGeneration = 'cdd2ad1c-48b4-41d4-84d2-d4e3b030d572';}
  };
}

test('signed Timeclock binding is required; browser role and device headers prove nothing', async () => {
  const f = fixture();
  assert.deepEqual(await f.staffSession.verifyBaseSession(req()), {
    employeeId: '17', active: true, binding: 'signed-unique-session-jti-17'
  });
  await assert.rejects(f.staffSession.verifyBaseSession(req('Bearer fake')), {
    code: 'HC_STAFF_SESSION_REQUIRED'
  });
  await assert.rejects(f.gate().authorize({request:req(),action:'tools.read'}), denied);
  await assert.rejects(f.gate().authorize({request:req(),action:'products.write'}), denied);
  f.expire();
  await assert.rejects(f.staffSession.verifyBaseSession(req()), {
    code: 'HC_STAFF_SESSION_REQUIRED'
  });
  assert.throws(() => createStaffBoundSessionAdapter(), TypeError);
  assert.throws(() => createStaffSecurityAccessGate(), TypeError);
});

test('signed, session-bound TOTP allows exact permitted routine actions but never privileged writes', async () => {
  const f = fixture();
  const ticket = await f.mfa.authenticate({context:req(),code:'123456',sourceIp:'203.0.113.10'});
  const request = {
    ...req(),
    get: name => name.toLowerCase() === 'x-hc-mfa-session'
      ? ticket.token : req().get(name)
  };
  const gate = f.gate();
  const allowed = await gate.authorize({request,action:'tools.read'});
  assert.equal(allowed.factorMethod,'totp');
  assert.equal(allowed.employeeId,'17');
  await assert.rejects(gate.authorize({request,action:'products.write'}),denied);
  await assert.rejects(gate.authorize({request,action:'inventory.adjust'}),denied);
  f.revoke();
  await assert.rejects(gate.authorize({request,action:'tools.read'}),denied);
  f.deactivate();
  await assert.rejects(f.staffSession.verifyEmployeeSession(req()), {
    code:'HC_STAFF_SESSION_REQUIRED'
  });
});

test('strong, backend-verified proof and exact operation grant are both required for protected writes', async () => {
  const f = fixture();
  let permitted = false;
  const gate = createStaffSecurityAccessGate({
    staffSession: f.staffSession,
    mfa: f.mfa,
    now: f.now,
    verifyStrongStepUp: async () => ({
      verified: true, employeeId: '17', method: 'passkey',
      authenticatedAtMs: NOW
    }),
    checkPermission: async ({operation}) => permitted && operation === 'products.write'
  });
  await assert.rejects(gate.authorize({request:req(),action:'products.write'}),denied);
  permitted = true;
  const granted = await gate.authorize({request:req(),action:'products.write'});
  assert.equal(granted.factorMethod,'passkey');
  assert.equal(granted.assurance,'step-up');
  await assert.rejects(gate.authorize({request:req(),action:'purchase-orders.write'}),denied);
  const spoofed = f.gate({verifyStrongStepUp: async () => ({
    verified: true, employeeId: '999', method: 'passkey', authenticatedAtMs: NOW
  })});
  await assert.rejects(spoofed.authorize({request:req(),action:'products.write'}),denied);
  const untrusted = f.gate({verifyStrongStepUp: async () => ({
    verified: true, employeeId:'17', method: 'pin', authenticatedAtMs: NOW
  })});
  await assert.rejects(untrusted.authorize({request:req(),action:'products.write'}),denied);
});

test('station proof works for routine reads only and backend errors fail closed', async () => {
  const f = fixture();
  const station = f.gate({
    verifyWorkstation: async () => ({
      verified:true,deviceId:'registered-store-station',expiresAtMs:NOW+30_000
    })
  });
  assert.equal((await station.authorize({request:req(),action:'tools.read'})).assurance,
    'workstation');
  await assert.rejects(station.authorize({request:req(),action:'products.write'}),denied);
  const offline = f.gate({ verifyWorkstation: async () => {throw Error('device offline');},
    verifyStrongStepUp: async () => {throw Error('provider offline');} });
  await assert.rejects(offline.authorize({request:req(),action:'tools.read'}),denied);
});

test('unlisted operations and failed permission checks remain denied even with verified MFA', async () => {
  const f = fixture();
  const ticket = await f.mfa.authenticate({context:req(),code:'123456',sourceIp:'203.0.113.10'});
  const request = {
    ...req(),
    get: name => name.toLowerCase() === 'x-hc-mfa-session'
      ? ticket.token : req().get(name)
  };
  await assert.rejects(f.gate().authorize({request,action:'customers.export'}),denied);
  await assert.rejects(f.gate().authorize({request,action:'__proto__'}),denied);
  await assert.rejects(f.gate().authorize({request,action:'tools.stage.extra'}),denied);
  await assert.rejects(f.gate({
    checkPermission: async () => { throw Error('Permission service unavailable'); }
  }).authorize({request,action:'tools.read'}),denied);
  await assert.rejects(f.gate({
    checkPermission: async () => 'true'
  }).authorize({request,action:'tools.read'}),denied);
});

test('strong-factor verification must be fresh and permission is checked per action', async () => {
  const f = fixture();
  for (const authenticatedAtMs of [NOW + 1, NOW - 300_000, Number.NaN]) {
    const gate = f.gate({
      verifyStrongStepUp: async () => ({
        verified:true,employeeId:'17',method:'passkey',authenticatedAtMs
      })
    });
    await assert.rejects(gate.authorize({request:req(),action:'products.write'}),denied);
  }
  const gate = f.gate({
    verifyStrongStepUp: async () => ({
      verified:true,employeeId:'17',method:'passkey',authenticatedAtMs:NOW
    }),
    checkPermission: async ({operation}) => operation === 'products.write'
  });
  assert.equal((await gate.authorize({request:req(),action:'products.write'})).assurance,'step-up');
  await assert.rejects(gate.authorize({request:req(),action:'inventory.adjust'}),denied);
  await assert.rejects(gate.authorize({request:req('Bearer signed-99'),action:'products.write'}),denied);
});

test('active off-clock owner and staff can use permitted tools; payroll clock status is not authorization', async () => {
  for (const [employeeId, clockedIn] of [['17', false], ['18', true], ['19', undefined]]) {
    const staffSession = createStaffBoundSessionAdapter({
      now: () => NOW,
      staffAuth: {
        verifyBoundEmployee: async () => ({
          id: employeeId, employeeId, active: true,
          role: employeeId === '17' ? 'owner' : 'staff',
          clockedIn,
          binding: 'signed-unique-session-' + employeeId,
          expiresAtMs: NOW + 60_000
        })
      }
    });
    const gate = createStaffSecurityAccessGate({
      staffSession,
      mfa: { verify: async () => { throw Error('No MFA token'); } },
      now: () => NOW,
      verifyWorkstation: async () => ({
        verified: true, deviceId: 'registered-test-station',
        expiresAtMs: NOW + 30_000
      }),
      checkPermission: async ({ identity, operation }) =>
        identity.id === employeeId && operation === 'tools.read'
    });
    assert.equal((await gate.authorize({request:req(),action:'tools.read'})).employeeId, employeeId);
    await assert.rejects(gate.authorize({request:req(),action:'products.write'}), denied);
  }
});

test('inactive employees are denied regardless of payroll clock state or registered workstation', async () => {
  for (const clockedIn of [true, false]) {
    const staffSession = createStaffBoundSessionAdapter({
      now: () => NOW,
      staffAuth: {
        verifyBoundEmployee: async () => ({
          id: '17', employeeId: '17', active: false, clockedIn,
          binding: 'signed-unique-session-jti-17',
          expiresAtMs: NOW + 60_000
        })
      }
    });
    const gate = createStaffSecurityAccessGate({
      staffSession,
      mfa: { verify: async () => { throw Error('No MFA token'); } },
      now: () => NOW,
      verifyWorkstation: async () => ({
        verified: true, deviceId: 'registered-test-station',
        expiresAtMs: NOW + 30_000
      }),
      checkPermission: async () => true
    });
    await assert.rejects(gate.authorize({request:req(),action:'tools.read'}), denied);
  }
});
