import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStaffSecuritySettingsRouter } from '../routes/staffSecuritySettings.js';
import { createStaffTotpProvisioningUri } from '../services/security/staffTotp.js';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const issuedUri = createStaffTotpProvisioningUri({ secret, employeeId: '17' });
async function fixture({ allow = false, factorState = 'not_enrolled' } = {}) {
  const calls = [];
  const app = express();
  app.locals.approved = allow;
  const totp = {
    status: async ({ context }) => {
      calls.push('status');
      assert.ok(context.get('authorization'));
      return factorState === 'pending'
        ? { state: 'pending', expiresAtMs: Date.now() + 300000 } : { state: factorState };
    },
    beginEnrollment: async ({ context }) => {
      calls.push('enroll');
      assert.ok(context.get('authorization'));
      return { provisioningUri: issuedUri, expiresAtMs: Date.now() + 600000 };
    },
    confirmEnrollment: async ({ context, code }) => {
      calls.push('confirm');
      assert.ok(context.get('authorization'));
      if (code !== '123456') throw Object.assign(new Error('No'), {
        code: 'HC_TOTP_INVALID', status: 401
      });
      return { confirmed: true };
    }
  };
  const verifyEmployee = async request => request.get('authorization') === 'Bearer signed-test-session'
    ? { id: 17, active: true } : null;
  const authorizeSettings = async ({ request, employee, action }) => {
    calls.push('authorize:' + action);
    assert.equal(employee.id, '17');
    return request.app.locals.approved === true;
  };
  app.use('/staff-security', createStaffSecuritySettingsRouter({
    verifyEmployee, authorizeSettings, totp
  }));
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/staff-security',
    calls, app, close: () => new Promise(resolve => server.close(resolve))
  };
}
const signed = { Authorization: 'Bearer signed-test-session' };

test('settings module refuses absent verification adapters', () => {
  assert.throws(() => createStaffSecuritySettingsRouter(), TypeError);
  assert.throws(() => createStaffSecuritySettingsRouter({ verifyEmployee: async () => ({}) }), TypeError);
});

test('public HTML has no enrolled factor credentials and requires browser-side scripts', async () => {
  const h = await fixture();
  try {
    const res = await fetch(h.url + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const html = await res.text();
    assert.match(html, /Employee Security Settings/);
    assert.match(html, /Authenticator app/);
    assert.match(html, /Passkeys/);
    assert.ok(!html.includes(secret));
    assert.ok(!html.includes('otpauth://'));
    assert.ok(!html.includes('<script>'));
    for (const asset of ['/client.js','/styles.css']) {
      const file = await fetch(h.url + asset);
      assert.equal(file.status, 200);
      assert.match(file.headers.get('cache-control'), /no-store/);
      assert.ok((await file.text()).length > 400);
    }
  } finally { await h.close(); }
});

test('employee PIN-only session and forged role/device request headers never permit settings access', async () => {
  const h = await fixture();
  try {
    const forged = {
      ...signed, 'X-Verified-Device': 'true', 'X-Employee-Role': 'admin',
      'Origin': 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };
    const a = await fetch(h.url + '/api/authenticator', { headers: forged });
    assert.equal(a.status, 403);
    const b = await fetch(h.url + '/api/authenticator/enroll', {
      method: 'POST', headers: { ...forged, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(b.status, 403);
    assert.equal(h.calls.filter(x => x === 'enroll').length, 0);
    const missing = await fetch(h.url + '/api/authenticator', { headers: {
      'X-Employee-Id': '17'
    } });
    assert.equal(missing.status, 403);
  } finally { await h.close(); }
});

test('approved employee may see factor status and enrollment QR without revealing any stored secret', async () => {
  const h = await fixture({ allow: true });
  try {
    const s = await fetch(h.url + '/api/authenticator', { headers: signed });
    assert.equal(s.status, 200);
    assert.deepEqual(await s.json(), { state: 'not_enrolled' });
    const invalid = await fetch(h.url + '/api/authenticator/enroll', {
      method: 'POST', headers: { ...signed, 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: '18', approved: true })
    });
    assert.equal(invalid.status, 400);
    assert.equal(h.calls.includes('enroll'), false);
    const e = await fetch(h.url + '/api/authenticator/enroll', {
      method: 'POST', headers: { ...signed, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(e.status, 200);
    assert.match(e.headers.get('cache-control'), /no-store/);
    assert.equal(e.headers.get('referrer-policy'), 'no-referrer');
    const data = await e.json();
    assert.equal(data.manualKey, secret);
    assert.match(data.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(data.qrDataUrl.split(',')[1], 'base64').subarray(0, 4).toString('hex'), '89504e47');
    assert.equal(data.provisioningUri, undefined);
    assert.ok(Number.isSafeInteger(data.expiresAtMs));
  } finally { await h.close(); }
});

test('confirmation validates code shape and never approves a wrong code', async () => {
  const h = await fixture({ allow: true, factorState: 'pending' });
  try {
    const s = await fetch(h.url + '/api/authenticator', { headers: signed });
    const state = await s.json();
    assert.equal(state.state, 'pending');
    assert.ok(Number.isSafeInteger(state.expiresAtMs));
    const invalid = await fetch(h.url + '/api/authenticator/confirm', {
      method: 'POST', headers: { ...signed, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123', employeeId: 17 })
    });
    assert.equal(invalid.status, 400);
    const wrong = await fetch(h.url + '/api/authenticator/confirm', {
      method: 'POST', headers: { ...signed, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '999999' })
    });
    assert.equal(wrong.status, 401);
    const ok = await fetch(h.url + '/api/authenticator/confirm', {
      method: 'POST', headers: { ...signed, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { confirmed: true });
    assert.equal(h.calls.filter(x => x === 'confirm').length, 2);
  } finally { await h.close(); }
});

test('already-active authenticator status never returns the seed or a recovery bypass', async () => {
  const h = await fixture({ allow: true, factorState: 'active' });
  try {
    const s = await fetch(h.url + '/api/authenticator', { headers: signed });
    assert.deepEqual(await s.json(), { state: 'active' });
    const reset = await fetch(h.url + '/api/authenticator/reset', {
      method: 'POST', headers: signed
    });
    assert.equal(reset.status, 404);
  } finally { await h.close(); }
});
