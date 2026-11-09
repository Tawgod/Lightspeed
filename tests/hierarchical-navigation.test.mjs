import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {toolGroups,allDestinations} from '../shared-ui/operations-nav.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const pages=[['special-orders','special-orders.html'],['ordering','ordering.html'],['preorders','preorders.html'],['gw-preorders','gw-preorders.html']];
test('unique verified destinations, nested dependent preorders',()=>{
 const ids=allDestinations.map(t=>t.id);
 assert.equal(new Set(ids).size,ids.length);
 assert.deepEqual(ids,['special-orders','preorders','gw-preorders','ordering','toolkit','consignment']);
 const parent=toolGroups.flatMap(g=>g.items).find(x=>x.id==='special-orders');
 assert.deepEqual(parent.children.map(t=>t.id),['preorders','gw-preorders']);
 for(const t of allDestinations)assert.ok(t.href.startsWith('/')||t.href.startsWith('https://'));
 assert.equal(allDestinations.find(t=>t.id==='consignment').beta,true);
});
for(const [id,path] of pages){
 test('page '+id+' uses shared directory and preserves existing employee auth',()=>{
  const s=read(path);
  assert.match(s,/src="\/shared-ui\/operations-nav\.mjs"/);
  assert.match(s,new RegExp('data-current-tool="'+id+'"'));
  assert.match(s,/id="employeePin"/);
  assert.match(s,/id="unlockButton"/);
  assert.match(s,/id="signOutButton"/);
  assert.equal((s.match(/class="hc-operations-links"/g)||[]).length,1);
  assert.ok(!s.includes('href="https://consignment-beta-test.up.railway.app/consignment"'),'no competing hardcoded tool nav');
 });
}
test('application serves module and keyboard/focus CSS',()=>{
 const server=read('server.js'),css=read('shared-ui/core-ops-compat.css'),nav=read('shared-ui/operations-nav.mjs');
 assert.match(server,/app\.get\('\/shared-ui\/operations-nav\.mjs'/);
 assert.match(css,/hc-nav-child/);
 assert.match(css,/aria-current="page"/);
 assert.match(nav,/e\.key==='Escape'/);
 assert.match(nav,/noopener noreferrer/);
 assert.match(nav,/replaceChildren\(fragment\)/);
});
