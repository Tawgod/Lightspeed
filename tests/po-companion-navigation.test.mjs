import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('PO Companion JS parses with current extension APIs',()=>{
 for(const path of ['extension/po-companion/panel.js','extension/po-companion/background.js','extension/po-companion/review.js','extension/po-companion/navigation.js']){
  assert.doesNotThrow(()=>new vm.Script(read(path),{filename:path}));
 }
});
test('navigation matches PR23 verified destinations, not unverified launchers',()=>{
 const links=JSON.parse(read('extension/po-companion/navigation.json'));
 assert.deepEqual(links.map(x=>x.label),['Special Orders','Ordering','Preorder Campaigns','GW Preorders','Consignment Manager (Beta)','Lightspeed Toolkit']);
 assert.equal(new Set(links.map(x=>x.url)).size,links.length);
 for(const link of links){const u=new URL(link.url);assert.equal(u.protocol,'https:');}
 assert.ok(links.find(x=>x.label.includes('Consignment'))?.beta);
});
test('approval and live PO writes remain fail-closed',()=>{
 const panel=read('extension/po-companion/panel.js');
 const worker=read('extension/po-companion/background.js');
 const review=read('extension/po-companion/review.html');
 assert.match(panel,/signIn\.disabled=true/);
 assert.match(worker,/Read-only PO gateway is not enabled/);
 assert.match(review,/Approve and Apply Changes/);
 assert.match(review,/<button[^>]+disabled/);
 assert.doesNotMatch(worker,/api\/2026-04\/products|method:\s*['"](?:PUT|PATCH|DELETE)['"]/);
});
test('review and panel share one navigation registry',()=>{
 assert.match(read('extension/po-companion/navigation.js'),/navigation\.json/);
 assert.match(read('extension/po-companion/background.js'),/po-companion\/navigation\.json/);
 assert.match(read('extension/po-companion/panel.js'),/HCT_PO_NAV/);
 assert.match(read('extension/po-companion/review.html'),/aria-current="page"/);
});
