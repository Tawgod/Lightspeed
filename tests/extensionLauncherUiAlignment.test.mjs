import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');

test('Timeclock and Split/Recall shared UI uses Hobby Corner navy/blue palette',()=>{
  assert.match(source,/hct-timeclock-launcher/);
  assert.match(source,/background:'#1769e9'/);
  assert.match(source,/background:'rgba\(16,44,72,\.68\)'/);
  assert.match(source,/background:'rgba\(16,44,72,\.72\)'/);
  assert.match(source,/background:'#102c48'/);
  assert.match(source,/background:'#e3ebf3'/);
  assert.match(source,/border:'1px solid #b9cadd'/);
});

test('Timeclock identity and API behavior remain present',()=>{
  assert.match(source,/function openTimeclockOverlay\(\)/);
  assert.match(source,/employeeIdentifier/);
  assert.match(source,/\/api\/timeclock\/status\?identifier=/);
  assert.match(source,/\/api\/timeclock\/.*clock-/);
});

test('Split Recall identification, retrieval and completion behavior remain present',()=>{
  assert.match(source,/function extractSaleRef\(\)/);
  assert.match(source,/function openSplitOverlay\(saleRef\)/);
  assert.match(source,/HCT_OPEN_SPLIT/);
  assert.match(source,/HCT_SPLIT_COMPLETE/);
  assert.match(source,/\/api\/work-orders\/eligible/);
  assert.match(source,/Retrieve to Register/);
});

test('Injected UI remains namespaced and inline-isolated from host CSS',()=>{
  assert.match(source,/hct-timeclock-overlay/);
  assert.match(source,/hct-split-overlay/);
  assert.match(source,/hct-timeclock-launcher/);
  assert.match(source,/hct-split-launcher/);
  assert.doesNotMatch(source,/document\.head\.appendChild\([^)]*style/i);
});
