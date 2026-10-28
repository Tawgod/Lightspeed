import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {copyHobbyCornerField} from '../extension/shared-ui/clipboard.mjs';
const html=fs.readFileSync('extension/product-scanner/review.html','utf8');
const script=fs.readFileSync('extension/product-scanner/review.js','utf8');
const theme=fs.readFileSync('extension/product-scanner/hc-beta.css','utf8');
test('scanner uses existing shaded UI panels, controls and original branding',()=>{
  for(const name of ['hc-panel','hc-inset','hc-button','hc-input','hc-select','hc-textarea'])assert.ok(html.includes(name));
  for(const id of ['employee-pin','supplier-tab','check-matches','copy','submit-product-proposal','preorder-campaign','stage-preorder','create-item'])assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html,/hc-wordmark.webp/);
  assert.match(theme,/--hc-canvas:#e3ebf3/);
  assert.match(theme,/--hc-header:#102c48/);
});
test('exact copy preserves leading zero identifiers, whitespace and multiline descriptions',async()=>{
  const original='  000012340005\\nLine one\\n\\n  Line two: ! &  ';
  let copied;
  const result=await copyHobbyCornerField({plainText:original},{clipboard:{writeText:async s=>{copied=s;}}});
  assert.equal(copied,original);
  assert.equal(result.format,'plain');
});
test('scanner uses shared helper, never coerces copied identifiers to numbers',()=>{
  assert.ok(script.includes('copyHobbyCornerField({plainText:JSON.stringify(currentProduct(),null,2)})'));
  assert.ok(!script.includes('parseInt(currentProduct().upc'));
});
test('feature scope retains authentication and backend create restrictions',()=>{
  assert.match(script,/SCANNER_API/);
  assert.match(script,/employee-sign-in/);
  assert.match(script,/CREATE TEST PRODUCT/);
  assert.ok(!script.includes('/api/2026-07/products'));
});
