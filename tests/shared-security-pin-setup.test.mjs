import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecurityStagingApp} from '../staging/staff-security-server.js';
import {createIsolatedTestLoginMount} from '../staging/isolated-test-login.js';
const origin='https://staff-security-staging-test.up.railway.app';
const environment={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_TEST_LOGIN_ENABLED:'true',HC_STAGING_PIN_SETUP_ENABLED:'true',
 HC_STAGING_PIN_SETUP_KEY:'test-only-32-byte-credential-abcde-1234567890-ABCDEFG',
 HC_STAGING_PUBLIC_ORIGIN:origin,
 HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
 HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
 HC_STAGING_SESSION_SECRET:'synthetic-test-session-secret-456789123',
 HC_STAGING_THROTTLE_SECRET:'synthetic-test-throttle-secret-456789123'
};
function fake(){
 const state={hash:null,completed:false,buckets:new Map()};
 const pool={
  async query(sql){if(sql.startsWith('SELECT pin_hash FROM hc_staging_pin_setup'))return {rows:[{pin_hash:state.hash}]};throw Error('Unexpected pool query');},
  async connect(){return{
   async query(sql,args=[]){
    if(sql.startsWith('SELECT pin_hash,completed_at FROM hc_staging_pin_setup'))return {rows:[{pin_hash:state.hash,completed_at:state.completed?new Date():null}]};
    if(sql.startsWith('UPDATE hc_staging_pin_setup')){if(state.completed)throw Error('Already used');state.hash=args[0];state.completed=true;return {rowCount:1};}
    if(sql.includes('INSERT INTO hc_staff_auth_throttle')){if(!state.buckets.has(args[0]))state.buckets.set(args[0],args[1]);return {rowCount:1,rows:[]};}
    if(sql.includes('SELECT balance,updated_at,clock_timestamp'))return {rowCount:1,rows:[{balance:state.buckets.get(args[0]),updated_at:new Date(),checked_at:new Date()}]};
    if(sql.includes('UPDATE hc_staff_auth_throttle')){state.buckets.set(args[0],args[1]);return {rowCount:1,rows:[]};}
    return {rowCount:0,rows:[]};
   },release(){}
  }}
 };
 return {state,pool};
}
test('one-time staging page creates PIN, signs in, then denies reuse and attacker requests',async()=>{
 const {state,pool}=fake();
 const m=createIsolatedTestLoginMount({environment,pool});
 const app=createSecurityStagingApp({environment,mountSecurity:m.mount});
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const setup=async(body,from=origin)=>fetch(base+'/api/test-pin-setup/set',{
    method:'POST',headers:{'Content-Type':'application/json','Origin':from},body:JSON.stringify(body)
  });
  assert.equal((await fetch(base+'/test-pin-setup')).status,200);
  assert.equal((await setup({setupKey:'invalid',pin:'1384'})).status,403);
  assert.equal((await setup({setupKey:environment.HC_STAGING_PIN_SETUP_KEY,pin:'1384'},'https://evil.example')).status,403);
  assert.equal(state.hash,null);
  let sign=await fetch(base+'/api/staff-auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'1384'})});
  assert.notEqual(sign.status,200,'Before setup PIN login fails closed');
  const created=await setup({setupKey:environment.HC_STAGING_PIN_SETUP_KEY,pin:'1384'});
  assert.equal(created.status,201);
  assert.match(state.hash,/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.equal(state.hash.includes('1384'),false);
  assert.equal((await setup({setupKey:environment.HC_STAGING_PIN_SETUP_KEY,pin:'9940'})).status,403);
  sign=await fetch(base+'/api/staff-auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'1384'})});
  assert.equal(sign.status,200);
  const signed=await sign.json();
  assert.equal(signed.employee.permissionSource,'synthetic_staging_only');
  assert.equal((await fetch(base+'/staff-security')).status,503);
  assert.equal((await fetch(base+'/api/staff-auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'9940'})})).status,401);
 }finally{await new Promise(ok=>server.close(ok));}
});
test('setup cannot mount outside test environment or with missing high-entropy setup key',()=>{
 const {pool}=fake();
 for(const changes of [
  {NODE_ENV:'production'},{HC_SECURITY_ENV:'production'},
  {HC_STAGING_TEST_OWNER_DISCORD_ID:'215626919134887940'},
  {HC_STAGING_PUBLIC_ORIGIN:'https://bad.example'},
  {HC_STAGING_PIN_SETUP_KEY:'short'}
 ])assert.throws(()=>createIsolatedTestLoginMount({environment:{...environment,...changes},pool}));
});
