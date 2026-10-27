import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const routes=['special-orders','ordering','preorders','gw-preorders'];
const expected=['/special-orders','/ordering','/preorders','/gw-preorders',
  'https://consignment-beta-test.up.railway.app/consignment',
  'https://lightspeed-api-production-c087.up.railway.app/extension'];
for(const route of routes){
 test('complete consistent tool navigation for '+route,()=>{
  const html=readFileSync(new URL('../'+route+'.html',import.meta.url),'utf8');
  const nav=html.match(/<nav class="hc-operations-nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav,'missing accessible navigation');
  const links=[...nav[1].matchAll(/<a href="([^"]+)"/g)].map(x=>x[1]);
  assert.deepEqual(links,expected);
  assert.match(nav[1],new RegExp('href="/'+route+'" aria-current="page"'));
  assert.ok(html.includes('shared-ui/core-ops-compat.css'));
  assert.match(html,/<body class="hc-ui">/);
 });
}
test('navigation styling is scoped and responsive',()=>{
 const css=readFileSync(new URL('../shared-ui/core-ops-compat.css',import.meta.url),'utf8');
 assert.match(css,/\.hc-ui \.hc-operations-nav/);
 assert.match(css,/\.hc-ui \.hc-operations-links/);
 assert.match(css,/\[aria-current="page"\]/);
 assert.match(css,/@media\(max-width:760px\)/);
});
