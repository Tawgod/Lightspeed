import test from 'node:test';
import assert from 'node:assert/strict';

// Read-only smoke against the independently deployed, deliberately
// uncredentialed PR63 staging service. Never point at production or Timcorp
// shared gateway. No employee token, vendor key or write request is used.
const origin='https://hc-foundation-pr63-staging.up.railway.app';
const prefix='/HobbyCorner';
const get=async(path,{redirect='manual'}={})=>{
 const url=new URL(path,origin);
 assert.equal(url.origin,origin,'Refuse non-staging target');
 const response=await fetch(url,{
  redirect,method:'GET',cache:'no-store',
  signal:AbortSignal.timeout(15000),
  headers:{'User-Agent':'HobbyCorner-PR63-Staging-ReadOnly-Smoke/1.0'}
 });
 const body=await response.text();
 return {response,body};
};
const expectStatus=async(path,status)=>{
 const result=await get(path);
 assert.equal(result.response.status,status,path+' unexpected status');
 console.log('PASS',status,path);
 return result;
};
test('fresh isolated database and live-vendor isolation verified by both health routes',async()=>{
 for(const path of ['/api/special-orders/health',prefix+'/api/special-orders/health']){
  const {body}=await expectStatus(path,200);
  const data=JSON.parse(body);
  assert.equal(data.database,true,'Must be connected to fresh staging Postgres');
  for(const flag of ['lightspeed','secured','liveMode','allowMigration','allowProductWrites','gwDiscordConfigured'])
   assert.equal(data[flag],false,'Unexpected live capability '+flag);
 }
});
test('legacy root URL still works and HobbyCorner root redirects within its prefix',async()=>{
 const legacy=await expectStatus('/',200);
 assert.match(legacy.body,/Lightspeed Avery Label API is running/);
 const prefixed=await expectStatus(prefix+'/',302);
 assert.equal(new URL(prefixed.response.headers.get('location'),origin).pathname,
  prefix+'/store-operations');
 const old=await expectStatus('/special-orders',200);
 // When a base path is configured, even legacy direct URLs serve the
 // same prefix-aware asset base; the original URLs remain reachable.
 assert.match(old.body,/<base href="\/HobbyCorner\/">/);
});
test('prefixed dashboard, special orders, preorders and GW pages load anchored to same origin',async()=>{
 for(const route of ['store-operations','special-orders','preorders','gw-preorders','ordering']){
  const {body,response}=await expectStatus(prefix+'/'+route,200);
  assert.match(body,/<base href="\/HobbyCorner\/">/,route);
  assert.match(response.headers.get('content-type')||'',/text\/html/);
 }
});
test('shared assets and browser router are same-origin and prefixed',async()=>{
 const css=await expectStatus(prefix+'/shared-ui/hc.css',200);
 assert.match(css.response.headers.get('content-type')||'',/text\/css/);
 assert.match(css.body,/\.hc-ui/);
 const nav=await expectStatus(prefix+'/shared-ui/operations-nav.mjs',200);
 assert.match(nav.body,/publicOperationsPath/);
 const js=await expectStatus(prefix+'/shared-ui/store-operations.mjs',200);
 assert.match(js.body,/publicOperationsPath/);
});
test('active zero-grant staging guard denies all anonymous reads; Admin and staff login remain disabled',async()=>{
 for(const path of [prefix+'/api/special-orders/stats',prefix+'/api/special-orders/priority-review'])
  await expectStatus(path,403);
 await expectStatus(prefix+'/api/admin/navigation-access',404);
 await expectStatus(prefix+'/api/staff-auth/session',404);
 await expectStatus(prefix+'/nonexistent-staging-path',404);
});

test('forged employee, Owner and service headers cannot bypass the active staging guard',async()=>{
 const path=prefix+'/api/special-orders/priority-review';
 for(const headers of [
  {'x-hc-role':'owner','x-hc-employee-id':'901'},
  {authorization:'Bearer forged-employee-token'},
  {'x-hobby-corner-key':'old-static-key'},
  {'x-service-id':'pretend-bot','authorization':'Bearer pretend-worker'}
 ]){
  const r=await fetch(new URL(path,origin),{
   method:'GET',redirect:'manual',cache:'no-store',headers,
   signal:AbortSignal.timeout(15000)
  });
  assert.equal(r.status,403,'Forged credential bypass unexpectedly accepted');
  assert.equal(r.headers.get('cache-control'),'no-store');
 }
});
