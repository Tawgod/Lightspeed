import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const routes=['special-orders','ordering','preorders','gw-preorders'];
const labels=['Special Orders','Ordering','Preorders','GW Preorders'];
for(const route of routes){
 test('coordinated navigation and PIN header '+route,()=>{
  const html=readFileSync(new URL('../'+route+'.html',import.meta.url),'utf8');
  const nav=html.match(/<nav class="hc-operations-nav hc-core-header"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav);
  for(const href of routes) assert.match(nav[1],new RegExp('href="\\/'+href+'"'));
  for(const label of labels) assert.match(nav[1],new RegExp('>'+label+'<'));
  assert.match(nav[1],new RegExp('href="\\/'+route+'"[^>]*aria-current="page"'));
  assert.match(nav[1],/hc-wordmark\.webp/);
  assert.match(nav[1],/More tools/);
  assert.match(nav[1],/Beta \/ Test/);
  assert.match(nav[1],/id="employeePin"/);
  assert.match(nav[1],/staffSignIn\(\)/);
  assert.match(nav[1],/id="signOutButton"/);
  assert.match(nav[1],/staffSignOut\(\)/);
  assert.match(html,/shared-ui\/staff-auth\.js/);
  assert.doesNotMatch(nav[1],/accessKey|saveKey\(/);
 });
}
test('responsive/focus/asset contract',()=>{
 const css=readFileSync(new URL('../shared-ui/core-ops-compat.css',import.meta.url),'utf8');
 const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(css,/\.hc-ui \.hc-operations-more summary:focus-visible/);
 assert.match(css,/\.hc-ui \.hc-operations-auth/);
 assert.match(css,/@media\(max-width:760px\)/);
 assert.match(server,/app.get\('\/shared-ui\/assets\/hc-wordmark.webp'/);
});
test('existing workflow anchors remain',()=>{
 const s=readFileSync(new URL('../special-orders.html',import.meta.url),'utf8');
 const o=readFileSync(new URL('../ordering.html',import.meta.url),'utf8');
 const p=readFileSync(new URL('../preorders.html',import.meta.url),'utf8');
 const g=readFileSync(new URL('../gw-preorders.html',import.meta.url),'utf8');
 assert.match(s,/id="customerSearch"/); assert.match(s,/id="orders"/);
 assert.match(o,/id="readyNotifications"/); assert.match(o,/id="deliveryQueue"/); assert.match(o,/id="lightspeedPurchaseOrders"/);
 assert.match(p,/id="discordWatch"/); assert.match(p,/id="preorderCampaign"/);
 assert.match(g,/id="gwPublishButton"/); assert.match(g,/id="gwCampaignSelect"/);
});
