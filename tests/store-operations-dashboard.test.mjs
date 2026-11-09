import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifiedCounts,formatUpdated,kpiMap,reviewMap} from '../shared-ui/store-operations.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('Dashboard rejects missing or malformed counts instead of showing fake zero',()=>{
 const keys=Object.keys(reviewMap);
 assert.deepEqual(verifiedCounts({old_open_items:3,ordered_over_7_days:0,supplier_sync_failures:1,delivery_failures:2},keys),
  {old_open_items:3,ordered_over_7_days:0,supplier_sync_failures:1,delivery_failures:2});
 for(const val of [null,undefined,-1,1.5,'0',NaN]){
  const invalid={old_open_items:val,ordered_over_7_days:0,supplier_sync_failures:1,delivery_failures:2};
  assert.throws(()=>verifiedCounts(invalid,keys));
 }
 assert.match(formatUpdated('not-a-date'),/unavailable/);
});
test('Home page preserves original logo, staff sign-in, navigation and review states',()=>{
 const html=read('store-operations.html');
 const source=read('shared-ui/store-operations.mjs');
 const server=read('server.js');
 for(const id of [...Object.values(kpiMap),...Object.values(reviewMap),'dashboardError','employeePin','unlockButton','signOutButton',
  'statsCoverage','priorityCoverage','prioritySummary'])assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(html,/hc-wordmark\.webp/);
 assert.match(html,/data-current-tool="home"/);
 assert.match(html,/Other bugs \/ service errors/);
 assert.match(html,/Not connected/);
 assert.match(server,/app\.get\('\/store-operations'/);
 assert.match(server,/app\.get\('\/shared-ui\/store-operations\.mjs'/);
 assert.match(source,/\/api\/special-orders\/stats/);
 assert.match(source,/\/api\/special-orders\/priority-review/);
 assert.match(source,/credentials:'omit'/);
 assert.match(source,/verifiedCounts/);
 assert.match(source,/Never leave numbers from an earlier successful request/);
 assert.match(source,/setText\('statsCoverage','Unavailable'\)/);
 assert.match(source,/setText\('prioritySummary','Review unavailable'\)/);
 assert.match(source,/window\.HCStaffAuth\?\.signOut/);
 assert.doesNotMatch(source,/innerHTML\s*=/);
 assert.doesNotMatch(source,/localStorage/);
});
test('Home only shows approved verified destinations',()=>{
 const html=read('store-operations.html');
 assert.match(html,/href="\/special-orders"/);
 assert.match(html,/href="\/ordering"/);
 assert.match(html,/href="\/preorders"/);
 assert.match(html,/href="\/gw-preorders"/);
 assert.doesNotMatch(html,/href="\/employee-admin\//);
});
