import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=x=>fs.readFileSync(x,'utf8');
test('scanner uses shaded Hobby Corner beta layout and original local wordmark',()=>{
 const html=read('extension/product-scanner/review.html');
 const theme=read('extension/product-scanner/hc-beta.css');
 assert.match(html,/href="hc-beta\.css"/);
 assert.match(html,/class="hc-ui"/);
 assert.match(html,/hc-wordmark\.webp/);
 assert.match(theme,/--hc-header:#102c48/);
 assert.match(theme,/--hc-canvas:#e3ebf3/);
 assert.match(theme,/var\(--hc-border\)/);
 assert.ok(fs.existsSync('extension/product-scanner/hc-wordmark.webp'));
});
test('scanner preserves review controls and explicit sandbox-only creation',()=>{
 const html=read('extension/product-scanner/review.html');
 const js=read('extension/product-scanner/review.js');
 for(const id of ['employee-pin','check-matches','create-item','submit-product-proposal','refresh-product-proposals','stage-preorder'])
  assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(js,/product-test-creation\/status/);
 assert.match(js,/CREATE TEST PRODUCT/);
 assert.match(js,/Isolated Test Store/);
 assert.match(js,/if\(d\.requiresSelection\)/);
 assert.doesNotMatch(js,/\/api\/2026-07\/products/);
});
test('toolkit popup uses local approved branding without losing Lightspeed tools',()=>{
 const html=read('extension/popup.html');
 assert.match(html,/href="popup-beta\.css"/);
 assert.match(html,/product-scanner\/hc-wordmark\.webp/);
 for(const id of ['sale-ref','scan-page','split','combine'])assert.match(html,new RegExp('id="'+id+'"'));
});
