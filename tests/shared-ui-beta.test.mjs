import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {copyHobbyCornerField} from '../shared-ui/clipboard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');

test('shared beta CSS is opt-in and includes the primary reusable components', () => {
  const css = read('shared-ui/hc.css');
  for (const selector of ['.hc-ui','.hc-panel','.hc-button','.hc-alert','.hc-badge',
    '.hc-table','.hc-field','.hc-modal','.hc-sidebar','.hc-loading']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.ok(!/\bbody\s*\{|:root\s*\{/.test(css), 'must not redefine host global CSS');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /focus-visible/);
});

test('sample showcase loads local assets and has no production data fetch', () => {
  const html = read('shared-ui/showcase.html');
  const js = read('shared-ui/showcase.mjs');
  assert.match(html, /class="hc-ui"/);
  assert.match(html, /hc-wordmark\.webp/);
  assert.match(html, /hc-icon\.webp/);
  assert.match(html, /alt="The Hobby Corner logo"/);
  assert.match(html, /Demonstration only/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /type="button"/);
  assert.ok(!/\bfetch\s*\(/.test(js));
  assert.ok(!/lightspeed-api|timeclock-production/.test(html + js));
});

test('Hobby Corner logos are real binary WebP images, not base64 placeholder text', () => {
  for (const name of ['hc-icon.webp','hc-wordmark.webp']) {
    const path = resolve(root, 'shared-ui/assets', name);
    assert.ok(statSync(path).size > 300, name);
    const first = readFileSync(path).subarray(0, 12);
    assert.equal(first.subarray(0,4).toString(), 'RIFF');
    assert.equal(first.subarray(8,12).toString(), 'WEBP');
  }
});

test('exact clipboard copy preserves leading zeroes, newlines and multiple spaces', async () => {
  const source = 'SKU: 000000006125\n  Desc:  two  spaces\nR/C × 2';
  let copied = null;
  const fake = {async writeText(s) {copied = s;}};
  const result = await copyHobbyCornerField({plainText:source}, {clipboard:fake,ClipboardItemType:null});
  assert.equal(result.format, 'plain');
  assert.equal(copied, source);
});

test('rich copy fallback preserves exact plain text; number coercion is rejected', async () => {
  let copied;
  const fake = {async writeText(s) {copied = s;}};
  const text = '0000045\nA  B';
  await copyHobbyCornerField({plainText:text,formattedHtml:'<b>formatted</b>'}, {clipboard:fake,ClipboardItemType:null});
  assert.equal(copied,text);
  await assert.rejects(() => copyHobbyCornerField({plainText:12345},{clipboard:fake}), TypeError);
});
