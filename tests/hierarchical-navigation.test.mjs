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
 assert.deepEqual(parent.children.map(t=>t.id),['preorders','ordering']);
 assert.deepEqual(parent.children[0].children.map(t=>t.id),['gw-preorders']);
 assert.equal(toolGroups.length,2);
 assert.equal(toolGroups[0].label,'Special Orders');
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

test('Priority Review uses authenticated read-only operational summaries and retains unknown bug coverage',()=>{
 const html=read('special-orders.html');
 const client=read('special-orders-client.js');
 const backend=read('special-orders.js');
 for(const id of ['hc-priority-title','hc-priority-old','hc-priority-aging','hc-priority-sync','hc-priority-delivery','hc-priority-source']){
   assert.ok(html.includes('id="'+id+'"'),id);
 }
 assert.match(html,/Other bugs &amp; system errors/);
 assert.match(html,/Not connected/);
 assert.match(backend,/router\.get\('\/priority-review', requireDb/);
 assert.match(backend,/router\.use\(async \(req, res, next\)/);
 assert.match(backend,/status NOT IN \('COMPLETED','CANCELLED'\)/);
 assert.match(backend,/interval '30 days'/);
 assert.match(backend,/lightspeed_sync_status='ERROR'/);
 assert.match(backend,/status='ERROR' AND channel IN/);
 assert.match(backend,/application_bugs:false/);
 assert.doesNotMatch(backend.match(/router\.get\('\/priority-review'[\s\S]*?\n  \}\);/)?.[0]||'',/\b(INSERT|UPDATE|DELETE)\b/);
 assert.match(client,/getJson\(api\+'\/priority-review'\)/);
 assert.match(client,/resetPriorityReview\(\)/);
 assert.match(client,/loadPriorityReview\(\)/);
 assert.match(client,/General application bugs not monitored here/);
 assert.match(client,/No flags in 4 checked categories/);
});
