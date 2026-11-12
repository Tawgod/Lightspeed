import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CORE_OPERATIONS_ROUTE_INVENTORY} from '../services/security/coreOperationsRouteInventory.js';
import {CORE_OPERATIONS_BROWSER_CALLERS} from '../services/security/coreOperationsBrowserCallerInventory.js';
import {stripPublicBasePath,normalizePublicBasePath} from '../services/publicBasePath.js';
import {publicOperationsPath} from '../shared-ui/operations-nav.mjs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('combined foundation retains security transaction and default-unmounted guard',()=>{
 const specialOrders=read('special-orders.js');
 const server=read('server.js');
 assert.match(specialOrders,/coreOperationsAdmission/);
 assert.match(specialOrders,/permitsLockedStatusTransition/);
 assert.match(specialOrders,/auditActor\(req,'discord-bot'\)/);
 assert.match(specialOrders,/not_before=now\(\)\+interval '5 minutes'/);
 assert.match(specialOrders,/submitted_quantity=\$1::integer/);
 assert.match(server,/createPublicBasePathMiddleware\(PUBLIC_BASE_PATH\)/);
 assert.match(server,/createAdminNavigationAccessRouter/);
 assert.match(server,/createSpecialOrdersRouter\(/);
 assert.match(server,/createIsolatedStagingCoreAdmission\(\{env:process\.env\}\)/,
   'Stage-only guard must be created by trusted server configuration');
 assert.match(server,/coreOperationsAdmission:\s*STAGING_CORE_ADMISSION/,
   'Guard must be passed before the Special Orders router registers its routes');
});

test('Priority Review is present in backend, page and pending inventory with no automatic grant',()=>{
 const source=read('special-orders.js');
 assert.match(source,/router\.get\('\/priority-review', requireDb/);
 const route=CORE_OPERATIONS_ROUTE_INVENTORY.find(r=>r.source==='special-orders.js'&&
   r.method==='GET'&&r.path==='/priority-review');
 assert.ok(route);
 assert.equal(route.kind,'read');
 assert.equal(route.review,'pending');
 assert.equal(route.operation,'special-orders.read');
 const client=CORE_OPERATIONS_BROWSER_CALLERS.find(x=>x.source==='special-orders-client.js');
 assert.ok(client.literalPrefixes.includes('/priority-review'));
 assert.match(read('shared-ui/store-operations.mjs'),/publicOperationsPath\('\/api\/special-orders\/priority-review'\)/);
});

test('existing routes and both proposed gateway prefix spellings remain usable without switching production URLs',()=>{
 for(const prefix of ['/hobby-corner','/HobbyCorner']){
  assert.equal(normalizePublicBasePath(prefix),prefix);
  assert.equal(stripPublicBasePath(prefix+'/api/special-orders/health',prefix),'/api/special-orders/health');
  assert.equal(publicOperationsPath('/preorders','https://test.example'+prefix+'/'),prefix+'/preorders');
  assert.equal(publicOperationsPath('/api/staff-auth/session','https://test.example'+prefix+'/'),prefix+'/api/staff-auth/session');
 }
 assert.equal(stripPublicBasePath('/special-orders','/HobbyCorner'),'/special-orders');
 assert.equal(publicOperationsPath('/store-operations','https://test.example/'),'/store-operations');
});

test('both Timeclock session and Admin permissions use the configured page base, not client headers',()=>{
 const auth=read('shared-ui/staff-auth.js');
 const nav=read('shared-ui/operations-nav.mjs');
 assert.match(auth,/document\.baseURI/);
 assert.match(auth,/staffSessionUrl\(\)/);
 assert.match(nav,/publicOperationsPath\('\/api\/admin\/navigation-access'\)/);
 assert.match(nav,/admin\.read/);
 assert.doesNotMatch(nav,/x-hc-role/);
});
