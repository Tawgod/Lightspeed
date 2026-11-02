import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('mobile six-digit Authenticator input exchanges for a short-lived signed MFA proof', async () => {
  const source = await readFile(new URL('../staff-security-client.js', import.meta.url), 'utf8');
  const callbacks = new Map();
  const elems = new Map();
  function element(id) {
    if (!elems.has(id)) elems.set(id, {
      value: '', textContent: '', hidden: false, disabled: false,
      style: {}, src: '', removeAttribute(field) { delete this[field]; },
      addEventListener(kind, fn) { callbacks.set(id + ':' + kind, fn); }
    });
    return elems.get(id);
  }
  let now = 2000000000000;
  const requests = [];
  const base = { token: 'signed-base-session', employee: { id: 17, name: 'Staff' } };
  const fakeAuth = {
    verify: async () => null,
    readSession: () => base,
    signOut: () => {},
    signIn: async () => base
  };
  const context = {
    window: { HCStaffAuth: fakeAuth, addEventListener(kind, fn) { callbacks.set('window:' + kind, fn); } },
    document: {
      getElementById: element,
      addEventListener(kind, fn) { callbacks.set('document:' + kind, fn); },
      hidden: false
    },
    navigator: { clipboard: { writeText: async () => {} } },
    Date: class extends Date { static now() { return now; } },
    fetch: async (url, init) => {
      requests.push({url, init});
      if (url.endsWith('/api/mfa/session')) return {
        ok: true, status: 200,
        json: async () => ({token:'aBc123.xYz456',expiresIn:300})
      };
      return {ok: true,status:200,json:async()=>({state:'none'})};
    },
    console
  };
  vm.runInNewContext(source, context, { filename: 'staff-security-client.js', timeout: 1000 });
  await Promise.resolve();
  const submit = callbacks.get('mfaForm:submit');
  assert.equal(typeof submit, 'function');
  element('mfaCode').value = '123456';
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/staff-security/api/mfa/session');
  assert.equal(JSON.parse(requests[0].init.body).code, '123456');
  assert.equal(element('mfaState').textContent, 'Verified');
  assert.equal(element('mfaCode').value, '');
  element('mfaCode').value = 'wrong';
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 1, 'malformed code never reaches API');
  context.document.hidden = true;
  callbacks.get('document:visibilitychange')();
  assert.equal(element('mfaState').textContent, 'Not verified');
});
