import test from 'node:test';
import assert from 'node:assert/strict';

// Read-only external acceptance of the separate synthetic employee Railway
// pilot. Do not use production, existing PR63 service or shared Timcorp URL.
const origin='https://hc-employee-pilot-test.up.railway.app';
const prefix='/HobbyCorner';
async function check(path,{method='GET'}={}){
  const url=new URL(path,origin);
  assert.equal(url.origin,origin);
  const response=await fetch(url,{
    method,redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(15_000),
    headers:{'user-agent':'HC-Employee-Pilot-ReadOnly-Acceptance/1.0'}
  });
  const body=await response.text();
  return {response,body};
}
test('isolated pilot HTTPS health confirms synthetic-only operation',async()=>{
  const {response,body}=await check('/health');
  assert.equal(response.status,200);
  assert.deepEqual(JSON.parse(body),{
    service:'hc-isolated-employee-read-pilot',
    ready:true,identity:'synthetic-only',liveBusinessData:false
  });
});
test('prefixed pilot UI, CSS and module are accessible with no-store browser protections',async()=>{
  const {response,body}=await check(prefix+'/');
  assert.equal(response.status,200);
  assert.match(body,/<title>Hobby Corner · Isolated employee read pilot<\/title>/);
  assert.match(body,/\/HobbyCorner\/pilot\.js/);
  assert.match(response.headers.get('content-security-policy')||'',/frame-ancestors 'none'/);
  assert.match(response.headers.get('cache-control')||'',/no-store/);
  for(const path of ['/pilot.css','/pilot.js']){
    const asset=await check(prefix+path);
    assert.equal(asset.response.status,200,path);
  }
});
test('no staff credential exposes NO orders, stats or approved device APIs',async()=>{
  for(const path of ['/api/special-orders/orders','/api/special-orders/stats']){
    const result=await check(prefix+path);
    assert.equal(result.response.status,403,path);
    assert.deepEqual(JSON.parse(result.body),{error:'Core Operations permission required.'});
  }
  const session=await check(prefix+'/api/staff-auth/session');
  assert.equal(session.response.status,401);
  const station=await check(prefix+'/staff-station/session');
  assert.equal(station.response.status,403);
});
test('all writes, missing Admin and other live business paths remain inaccessible',async()=>{
  const mutation=await check(prefix+'/api/special-orders/orders',{method:'POST'});
  assert.equal(mutation.response.status,403);
  const admin=await check(prefix+'/api/admin/navigation-access');
  assert.equal(admin.response.status,404);
  const unknown=await check(prefix+'/api/special-orders/notifications/1/claim-discord');
  assert.equal(unknown.response.status,403);
  assert.equal((await check(prefix+'/not-found')).response.status,404);
});
