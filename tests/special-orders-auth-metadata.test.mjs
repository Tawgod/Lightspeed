import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSpecialOrdersRouter } from '../special-orders.js';

// Development-only regression: do not alter the existing login flow while
// coordinating a separately approved replacement with signed staff assurance.
test('Special Orders health and denied-auth logs do not disclose admin-key length', async () => {
  const key = 'fixture-only-private-key-0123456789';
  const app = express();
  app.use('/api/special-orders', createSpecialOrdersRouter({
    adminKey: key,
    verifyEmployee: async () => { throw Error('Untrusted staff session'); }
  }));
  const server = await new Promise(resolve => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  const original = console.log;
  const logLines = [];
  console.log = (...args) => { logLines.push(args.map(String).join(' ')); };
  try {
    const base = 'http://127.0.0.1:' + server.address().port + '/api/special-orders';
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.secured, true);
    assert.equal(Object.hasOwn(body, 'adminKeyLength'), false);
    assert.equal(Object.hasOwn(body, 'adminKeyTrimmedLength'), false);
    assert.ok(!JSON.stringify(body).includes(key));

    const denied = await fetch(base + '/auth-check', {
      headers: {'x-hobby-corner-key': 'wrong-fixture-key'}
    });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).ok, undefined);

    // Compatibility only, pending replacement with verified employee sessions.
    const approved = await fetch(base + '/auth-check', {
      headers: {'x-hobby-corner-key': key}
    });
    assert.equal(approved.status, 200);
    const authorized = await approved.json();
    assert.equal(authorized.authMode, 'legacy_admin_key');

    assert.ok(!logLines.some(line =>
      /adminkeylength|adminkeytrimmedlength|suppliedkeylength|auth diagnostic/i.test(line)
      || line.includes(key)
    ));
  } finally {
    console.log = original;
    await new Promise(resolve => server.close(resolve));
  }
});
