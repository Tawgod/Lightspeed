import test from 'node:test';
import assert from 'node:assert/strict';
import {createScannerSessions} from '../services/scannerSessions.js';
import {createIsolatedNavBridge,validateIsolatedNavBridge} from '../scripts/admin-nav-isolated-bridge.mjs';

const base={
 HC_NAV_BRIDGE_TEST_ENABLED:'true',
 HC_NAV_BRIDGE_ENVIRONMENT:'test',HC_NAV_BRIDGE_TARGET:'Postgres-O39p',
 RAILWAY_ENVIRONMENT_NAME:'test',
 HC_NAV_BRIDGE_DB_HOST:'postgres-o39p.railway.internal',
 HC_NAV_BRIDGE_DB_NAME:'railway',
 HC_ADMIN_NAV_READER_PASSWORD:'A'.repeat(64),PORT:'3000'
};
function createPool({grant=false}={}){
 const calls=[];
 const pool={async query(sql,params){
  calls.push({sql,params});
  if(sql.includes('current_database() AS name'))return {rowCount:1,rows:[{name:'railway',login:'hc_admin_nav_reader'}]};
  if(sql.includes('principals_exists'))return {rowCount:1,rows:[{
   principals_exists:true,grants_exists:true,principals_read:true,grants_read:true,
   principals_write:false,grants_write:false,schema_write:false
  }]};
  if(sql.includes('SELECT 1 FROM hc_admin_principals'))return {rowCount:grant?1:0,rows:grant?[{one:1}]:[]};
  throw Error('Unknown SQL');
 },async end(){calls.push({sql:'END'})}};
 return {pool,calls};
}
async function requestApp(bridge,callback){
 const server=await new Promise(resolve=>{const s=bridge.app.listen(0,'127.0.0.1',()=>resolve(s))});
 try{return await callback('http://127.0.0.1:'+server.address().port)}
 finally{
  await new Promise(resolve=>server.close(resolve));
  await bridge.close();
 }
}
test('isolated config rejects wrong DB, production, or incomplete identity credential set',()=>{
 assert.equal(validateIsolatedNavBridge(base).identityReady,false);
 for(const change of [
  {HC_NAV_BRIDGE_TEST_ENABLED:'false'},
  {HC_NAV_BRIDGE_ENVIRONMENT:'production'},
  {HC_NAV_BRIDGE_TARGET:'Postgres'},
  {RAILWAY_ENVIRONMENT_NAME:'production'},
  {HC_NAV_BRIDGE_DB_HOST:'public.example.com'},
  {HC_NAV_BRIDGE_DB_NAME:'other-db'},
  {HC_ADMIN_NAV_READER_PASSWORD:'weak'},
  {HC_NAV_BRIDGE_SESSION_SECRET:'x'.repeat(40)},
  {HC_NAV_BRIDGE_TIMECLOCK_ORIGIN:'https://timeclock.example.test'}
 ])assert.throws(()=>validateIsolatedNavBridge({...base,...change}),/rejected/);
});
test('real read-only grant reader but missing Timeclock verifier always denies',async()=>{
 const {pool,calls}=createPool({grant:true});
 const bridge=await createIsolatedNavBridge({
  env:base,poolFactory:()=>pool
 });
 assert.equal(bridge.identityReady,false);
 await requestApp(bridge,async root=>{
  const health=await fetch(root+'/health');
  assert.equal(health.status,200);
  assert.equal((await health.json()).employeeVerifier,'disabled');
  for(const token of [undefined,'Bearer signed.mock','Bearer valid-looking']) {
   const response=await fetch(root+'/api/admin/navigation-access',{
    headers:token?{Authorization:token}:{}
   });
   assert.equal(response.status,403);
   assert.match(response.headers.get('cache-control'),/no-store/);
  }
 });
 assert.equal(calls.filter(x=>x.sql.includes('SELECT 1 FROM hc_admin_principals')).length,0);
 assert.equal(calls.at(-1).sql,'END');
});
test('signed session plus revalidated active Timeclock identity plus grant controls access',async()=>{
 const now=2_000_000_000_000;
 const sessionSecret='session-signing-test-'.repeat(3);
 const sessions=createScannerSessions({secret:sessionSecret,now:()=>now});
 const session=sessions.issue({id:903});
 const env={...base,HC_NAV_BRIDGE_SESSION_SECRET:sessionSecret,
  HC_NAV_BRIDGE_TIMECLOCK_ORIGIN:'https://timeclock.example.test/',
  HC_NAV_BRIDGE_TIMECLOCK_SECRET:'timeclock-secret-'.repeat(3)};
 let active=true,granted=true,checks=0;
 const {pool,calls}=createPool({grant:true});
 const livePool={...pool,query:async(sql,params)=>{
  if(sql.includes('SELECT 1 FROM hc_admin_principals'))return {rowCount:granted?1:0,rows:[]};
  return pool.query(sql,params);
 }};
 const bridge=await createIsolatedNavBridge({
  env,poolFactory:()=>livePool,
  sessionFactory:()=>sessions,
  identityFactory:()=>({authorize:async id=>{
   checks++;
   if(!active)throw Error('inactive');
   return {id,permissionSource:'timeclock_employee',name:'Synthetic fixture'};
  }})
 });
 await requestApp(bridge,async root=>{
  const uri=root+'/api/admin/navigation-access';
  const get=token=>fetch(uri,{headers:token?{Authorization:'Bearer '+token}:{}});
  assert.equal((await get()).status,403);
  assert.equal((await get(session)).status,200);
  granted=false;assert.equal((await get(session)).status,403);
  granted=true;active=false;assert.equal((await get(session)).status,403);
  active=true;assert.equal((await get('fake.session')).status,403);
  assert.equal(checks,3,'Timeclock is rechecked per valid signed request');
 });
 assert.equal(calls.at(-1).sql,'END');
});
test('fail-closed database preflight never creates a listener or writes grants',async()=>{
 const {pool,calls}=createPool();
 const denyPool={...pool,query:async sql=>{
  if(sql.includes('principals_exists'))return {rowCount:1,rows:[{
   principals_exists:true,grants_exists:true,principals_read:true,grants_read:true,
   principals_write:true,grants_write:false,schema_write:false
  }]};
  return pool.query(sql);
 }};
 await assert.rejects(createIsolatedNavBridge({env:base,poolFactory:()=>denyPool}),/rejected/);
 assert.equal(calls.at(-1).sql,'END');
 assert.ok(calls.every(x=>!/(?:^INSERT|^UPDATE|^DELETE|^CREATE|^ALTER)/.test(x.sql)));
});
