import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaffTotpProvisioningUri, generateStaffTotpSecret, matchStaffTotpStep } from '../services/security/staffTotp.js';
import { createStaffAccessBaseline } from '../services/security/staffAccessBaseline.js';

// RFC 6238 SHA-1 test secret ("12345678901234567890") in Base32.
// At 59s, 8-digit RFC output is 94287082 => 6-digit Google-style 287082.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
test('standard 6-digit TOTP is compatible with RFC 6238 and 30-second windows', () => {
  assert.equal(matchStaffTotpStep({ secret: RFC_SECRET, code: '287082', nowMs: 59000 }), 1);
  assert.equal(matchStaffTotpStep({ secret: RFC_SECRET, code: '287082', nowMs: 89000 }), 1);
  assert.equal(matchStaffTotpStep({ secret: RFC_SECRET, code: '287082', nowMs: 150000 }), null);
  assert.equal(matchStaffTotpStep({ secret: RFC_SECRET, code: '287082', nowMs: 0 }), null);
  assert.equal(matchStaffTotpStep({ secret: RFC_SECRET, code: '287082', nowMs: -1 }), null);
  assert.equal(matchStaffTotpStep({ secret: RFC_SECRET, code: 287082, nowMs: 59000 }), null);
  assert.equal(matchStaffTotpStep({ secret: RFC_SECRET, code: '28782', nowMs: 59000 }), null);
  assert.throws(() => matchStaffTotpStep({ secret: 'INVALID', code: '287082', nowMs: 59000 }), TypeError);
});
test('generated enrollment secrets are random and otpauth URLs never include PINs', () => {
  const secret = generateStaffTotpSecret();
  const next = generateStaffTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.notEqual(secret, next);
  const uri = createStaffTotpProvisioningUri({ secret, employeeId: '17' });
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.hostname, 'totp');
  assert.equal(parsed.searchParams.get('secret'), secret);
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.equal(parsed.searchParams.get('period'), '30');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.ok(!uri.includes('1234'));
  assert.throws(() => createStaffTotpProvisioningUri({ secret, employeeId: '../evil' }), TypeError);
  assert.throws(() => createStaffTotpProvisioningUri({ secret, employeeId: '17', issuer: '' }), TypeError);
});
test('a server-verified TOTP code enables remote reads, but not high-risk writes', async () => {
  const clock = Date.parse('2026-10-30T16:00:00Z');
  const policy = createStaffAccessBaseline({
    now: () => clock,
    verifyEmployeeSession: async () => ({ id: 17, active: true }),
    verifyStepUp: async () => ({
      verified: true, employeeId: '17', method: 'totp', authenticatedAtMs: clock - 2000
    }),
    checkPermission: async x => x.identity.id === '17' &&
      x.factorMethod === 'totp' && x.operation === 'tools.read'
  });
  const r = await policy.authorize({ request: { verifiedBackendSession: true }, action: 'tools.read' });
  assert.equal(r.assurance, 'step-up');
  assert.equal(r.factorMethod, 'totp');
  for (const action of ['products.write','purchase-orders.write','inventory.adjust',
    'sales.write','store-credit.write','staff.permissions']) {
    await assert.rejects(policy.authorize({ request: {}, action }),
      err => err.code === 'HC_STAFF_ACCESS_DENIED');
  }
});
