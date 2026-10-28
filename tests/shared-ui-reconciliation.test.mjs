import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {copyHobbyCornerField} from '../shared-ui/clipboard.mjs';
const read = p => readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('shared web CSS retains scoped design foundation',()=>{
 const css=read('shared-ui/hc.css');
 for(const name of ['.hc-ui','.hc-panel','.hc-button','.hc-table','.hc-badge','.hc-modal'])assert.ok(css.includes(name),name);
 assert.ok(!/^\s*(?:body|:root)\s*\{/m.test(css));
});
test('core operations still link shared CSS without replacing business handlers',()=>{
 for(const p of ['special-orders.html','ordering.html','preorders.html','gw-preorders.html']){
  const html=read(p);
  assert.ok(html.includes('/shared-ui/hc.css'),p);
  assert.ok(html.includes('/shared-ui/core-ops-compat.css'),p);
 }
});
test('extension has deliberately scoped per-surface styles',()=>{
 assert.ok(read('extension/product-scanner/hc-beta.css').includes('.hc-ui'));
 assert.ok(read('extension/popup-beta.css').includes('body.hc-ui'));
});
test('source-faithful plain clipboard retains formatting and leading zeroes',async()=>{
 const original='SKU: 0000035006\r\n  original  spacing\nR/C – 🧩';
 let textWritten;
 const r=await copyHobbyCornerField({plainText:original},{clipboard:{async writeText(v){textWritten=v}},ClipboardItemType:null});
 assert.equal(r.format,'plain');
 assert.equal(textWritten,original);
});
test('rich clipboard unsupported falls back to unmodified plain text',async()=>{
 let textWritten;
 await copyHobbyCornerField({plainText:'000045\nnext',formattedHtml:'<strong>000045</strong>'},{clipboard:{async writeText(v){textWritten=v}},ClipboardItemType:null});
 assert.equal(textWritten,'000045\nnext');
});
