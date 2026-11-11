import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  createPublicBasePathMiddleware,
  normalizePublicBasePath,
  normalizePublicLandingPath,
  publicUrl,
  stripPublicBasePath
} from '../services/publicBasePath.js';

test('normalizes safe public base paths and landing paths', () => {
  assert.equal(normalizePublicBasePath(''), '');
  assert.equal(normalizePublicBasePath('/'), '');
  assert.equal(normalizePublicBasePath('/hobby-corner/'), '/hobby-corner');
  assert.equal(normalizePublicBasePath('/hobby-corner/labels'), '/hobby-corner/labels');
  assert.equal(normalizePublicLandingPath('special-orders'), '/special-orders');
  assert.equal(normalizePublicLandingPath('/index.html/'), '/index.html');

  for (const value of ['hobby-corner', '/a//b', '/../a', '/a?x=1', '/a#x', '/a\\\\b']) {
    assert.throws(() => normalizePublicBasePath(value));
  }
  for (const value of ['../special-orders', 'special-orders?x=1', 'a//b']) {
    assert.throws(() => normalizePublicLandingPath(value));
  }
});

test('strips only the configured prefix and preserves existing root routes', () => {
  assert.equal(
    stripPublicBasePath('/hobby-corner/special-orders?view=open', '/hobby-corner'),
    '/special-orders?view=open'
  );
  assert.equal(stripPublicBasePath('/hobby-corner', '/hobby-corner'), '/');
  assert.equal(stripPublicBasePath('/special-orders', '/hobby-corner'), '/special-orders');
  assert.equal(stripPublicBasePath('/hobby-cornerish/special-orders', '/hobby-corner'), '/hobby-cornerish/special-orders');
  assert.equal(publicUrl('/hobby-corner', 'special-orders'), '/hobby-corner/special-orders');
});

test('middleware records whether the request arrived through the public prefix', () => {
  let nextCalled = false;
  const req = { url: '/hobby-corner/api/staff-auth/session?fresh=1' };
  const res = { locals: {} };
  createPublicBasePathMiddleware('/hobby-corner')(req, res, () => { nextCalled = true; });

  assert.equal(req.url, '/api/staff-auth/session?fresh=1');
  assert.equal(req.hcPublicBasePath, '/hobby-corner');
  assert.equal(req.hcPublicPathMatched, true);
  assert.equal(res.locals.publicBasePath, '/hobby-corner');
  assert.equal(nextCalled, true);
});

test('browser entry files do not escape the configured gateway path', async () => {
  const htmlFiles = ['index.html', 'special-orders.html', 'ordering.html', 'preorders.html', 'gw-preorders.html'];
  for (const file of htmlFiles) {
    const source = await fs.readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:href|src)=["']\/(?!\/)/, file + ' contains a root-absolute browser asset/navigation URL');
  }

  const browserJsFiles = [
    'special-orders-client.js',
    'ordering-client.js',
    'preorders-client.js',
    'gw-preorders-client.js',
    'shared-ui/staff-auth.js'
  ];
  for (const file of browserJsFiles) {
    const source = await fs.readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /fetch\s*\(\s*["'\x60]\/api\//, file + ' contains a root-absolute API fetch');
  }

  const splitSource = await fs.readFile(new URL('../routes/orderSplit.js', import.meta.url), 'utf8');
  assert.doesNotMatch(splitSource, /fetch\s*\(\s*["'\x60]\/api\//, 'order split test harness contains a root-absolute API fetch');
  assert.match(splitSource, /<base href=/, 'order split test harness must anchor relative API calls at the public base path');

  const serverSource = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(serverSource, /createPublicBasePathMiddleware\(PUBLIC_BASE_PATH\)/);
  assert.doesNotMatch(serverSource, /https:\/\/special-orders-test-production\.up\.railway\.app\/special-orders/);
});
