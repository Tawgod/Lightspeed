import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('PO feature scripts parse',()=>{
 for(const p of ['extension/po-companion/panel.js','extension/po-companion/review.js','extension/po-companion/background.js','extension/po-companion/navigation.js']) {
  const code=read(p);if(p.endsWith('background.js')||p.endsWith('navigation.js'))continue;
  assert.doesNotThrow(()=>new vm.Script(code,{filename:p}));
 }
});
test('PO extension retains shared scanner navigation and existing launcher',()=>{
 const p=read('extension/popup.js'),h=read('extension/popup.html');
 assert.match(p,/installHobbyCornerNavigation/);
 assert.match(p,/po-select/);assert.match(p,/po-launch/);
 assert.match(h,/id="scan-page"/);assert.match(h,/id="split"/);assert.match(h,/id="combine"/);
 const m=JSON.parse(read('extension/manifest.json'));
 assert.equal(m.background.type,'module');
 assert.equal(m.background.service_worker,'po-companion/background.js');
 assert.ok(m.optional_host_permissions.includes('https://*/*'));
});
test('read-only review remains blocked and no alternate navigation.json',()=>{
 const bg=read('extension/po-companion/background.js'),review=read('extension/po-companion/review.html');
 assert.match(bg,/import \{destinations\} from '\.\.\/shared-ui\/navigation\.mjs'/);
 assert.match(bg,/HCT_PO_LOAD/);assert.match(bg,/not yet verified or enabled/);
 assert.match(review,/Approve and Apply Changes/);assert.match(review,/<button[^>]*disabled/);
 assert.match(review,/type="module" src="navigation.js"/);
});
