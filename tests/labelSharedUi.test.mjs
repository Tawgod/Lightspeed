import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../shared-ui/hc.css', import.meta.url), 'utf8');

test('PO label maker opts into shared UI without changing existing DOM contracts', () => {
  assert.match(html, /class="hc-ui label-app"/);
  for (const id of ['templateSelect','startRow','startCol','customText','loading','itemsTable','itemsBody','generateBtn']) {
    assert.match(html, new RegExp('id="'+id+'"'));
  }
  assert.match(html, /fetch\('\/api\/templates'\)/);
  assert.match(html, /fetch\(\x60\/api\/po\/\x24\{poId\}\/data\x60\)/);
  assert.match(html, /fetch\('\/api\/labels\/generate'/);
});
test('Hobby Corner label UI uses existing shared beta CSS and local brand asset routes', () => {
  assert.match(html, /\/label-ui\/hc\.css/);
  assert.match(html, /\/label-ui\/hc-wordmark\.webp/);
  assert.match(server, /app\.get\('\/label-ui\/hc\.css'/);
  assert.match(server, /app\.get\('\/label-ui\/hc-wordmark\.webp'/);
  assert.match(css, /\.hc-ui \.hc-panel/);
  assert.match(css, /--hc-header:#102c48/);
});
test('Avery PDF remains bound to its original backend, not a new print implementation', () => {
  assert.match(server, /app\.post\('\/api\/labels\/generate'/);
  assert.match(server, /const positionOnPage = labelCount % 30/);
  assert.match(server, /const originX = 13\.5 \+ \(col \* 198\)/);
});
