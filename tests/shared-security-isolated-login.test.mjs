import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createSecurityStagingApp} from '../staging/staff-security-server.js';
import {createIsolatedTestLoginMount} from '../staging/isolated-test-login.js';
import {hashIsolatedTestPin} from '../staging/isolated-test-identity.js';
const env={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',HC_STAGING_TEST_LOGIN_ENABLED:'true',
 HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
 HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
 HC_STAGING_TEST_PIN_HASH:hashIsolatedTestPin('6047',Buffer.alloc(16,9)),
 HC_STAGING_SESSION_SECRET:'synthetic-test-session-hmac-only-1234567890',
 HC_STAGING_THROTTLE_SECRET:'synthetic-test-throttle-hmac-only-1234567890'
};
function fakePool(){
 const statements=[],buckets=new Map();
 return {statements,connect:async()=>({
  async query(sql,args=[]){
   statements.push(String(sql));
   if(/INSERT INTO hc_staff_auth_throttle/.test(sql)){if(!buckets.has(args[0]))buckets.set(args[0],Number(args[1]));return {rowCount:1,rows:[]};}
   if(/SELECT balance,updated_at,clock_timestamp/.test(sql))return {rowCount:1,rows:[{balance:buckets.get(args[0]),updated_at:new Date(),checked_at:new Date()}]};
   if(/UPDATE hc_staff_auth_throttle/.test(sql)){buckets.set(args[0],Number(args[1]));return {rowCount:1,rows:[]};}
   return {rowCount:0,rows:[]};
  },release(){}
 })};
}
test('only isolated synthetic PIN sessions are mounted; factor endpoints denied',async()=>{
 const pool=fakePool();
 const login=createIsolatedTestLoginMount({environment:env,pool});
 const app=createSecurityStagingApp({environment:env,mountSecurity:login.mount});
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s))});
 try{
  const url='http://127.0.0.1:'+server.address().port;
  const post=pin=>fetch(url+'/api/staff-auth/session',{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})
  });
  assert.equal((await post('6048')).status,401);
  const ok=await post('6047');assert.equal(ok.status,200);
  const data=await ok.json();assert.equal(data.employee.id,'901');
  assert.equal(data.employee.permissionSource,'synthetic_staging_only');
  assert.ok(data.token && !data.token.includes('6047'));
  assert.equal((await fetch(url+'/api/staff-auth/session',{
   headers:{Authorization:'Bearer '+data.token}
  })).status,200);
  assert.equal((await fetch(url+'/api/staff-auth/session',{
   headers:{Authorization:'Bearer forged'}
  })).status,401);
  const page=await fetch(url+'/test-login');
  assert.equal(page.status,200);
  assert.match(await page.text(),/Test employee sign-in/);
  assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  const js=await fetch(url+'/test-login.js');
  assert.equal(js.status,200);
  const client=await js.text();
  assert.match(client,/signedSession/);
  assert.doesNotMatch(client,/localStorage|sessionStorage/);
  assert.equal((await fetch(url+'/test-login.css')).status,200);
  assert.equal((await fetch(url+'/staff-enrollment-invites/bot/issue')).status,503);
  assert.equal((await fetch(url+'/staff-security/')).status,503);
  assert.ok(pool.statements.some(x=>x.includes('hc_staff_auth_throttle')));
 }finally{await new Promise(ok=>server.close(ok))}
});
test('cannot mount staging test login outside guard or without separate secrets',()=>{
 const pool=fakePool();
 for(const delta of [
  {NODE_ENV:'production'},{HC_SECURITY_ENV:'production'},
  {HC_STAGING_TEST_LOGIN_ENABLED:'false'},
  {HC_STAGING_SESSION_SECRET:'short'},
  {HC_STAGING_THROTTLE_SECRET:''},
  {HC_STAGING_TEST_PIN_HASH:'6047'}
 ]) assert.throws(()=>createIsolatedTestLoginMount({environment:{...env,...delta},pool}));
});
