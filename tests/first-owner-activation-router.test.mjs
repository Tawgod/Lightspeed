import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createFirstOwnerActivationRouter} from '../routes/firstOwnerActivation.js';
import {createIsolatedFirstOwnerSetup} from '../services/security/isolatedFirstOwnerSetup.js';

test('Owner activation screen and route require same-origin evidence plus backend authorization',async()=>{
 let begins=0,finishes=0;
 const candidate={
  beginRegistration:async({context})=>{
   begins++;
   assert.equal(context.get('x-hc-owner-activation'),'A'.repeat(43));
   assert.equal(context.get('authorization'),'Bearer test-session');
   return {challengeId:'d2d2d2d2-eeee-4bbb-8ddd-cccccccccccc',
    options:{challenge:'AA',user:{id:'AA'}}};
  },
  finishRegistration:async({context,challengeId,response})=>{
   finishes++;
   assert.equal(context.get('x-hc-owner-activation'),'A'.repeat(43));
   assert.equal(challengeId,'d2d2d2d2-eeee-4bbb-8ddd-cccccccccccc');
   assert.equal(response.id,'credential-1');
   return {registered:true};
  }
 };
 assert.throws(()=>createFirstOwnerActivationRouter({candidate,origin:'http://evil.example'}),TypeError);
 assert.throws(()=>createFirstOwnerActivationRouter({origin:'http://localhost'}),TypeError);
 const origin='http://localhost';
 const app=express();
 app.use('/owner-setup',createFirstOwnerActivationRouter({candidate,origin}));
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 const base='http://127.0.0.1:'+server.address().port+'/owner-setup';
 const post=(path,body,headers={})=>fetch(base+path,{
  method:'POST',headers:{
   'Content-Type':'application/json',
   'Origin':origin,'Sec-Fetch-Site':'same-origin',
   'Authorization':'Bearer test-session',
   'X-HC-Owner-Activation':'A'.repeat(43),
   ...headers
  },body:JSON.stringify(body)
 });
 try{
  let page=await fetch(base+'/');
  assert.equal(page.status,200);
  assert.match(await page.text(),/Connect your Owner account/);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'),'no-store, max-age=0');
  let client=await fetch(base+'/client.js');
  assert.equal(client.status,200);
  assert.match(await client.text(),/navigator.credentials.create/);
  for(const changes of [
    {'Origin':'http://attacker.example'},
    {'Origin':''},
    {'Sec-Fetch-Site':'cross-site'},
    {'Sec-Fetch-Site':''},
    {'X-HC-Owner-Activation':'1234'},
    {'Content-Type':'text/plain'}
  ]){
   const rejected=await post('/registration/options',{},changes);
   assert.equal(rejected.status,403);
   assert.equal(begins,0,'malformed or cross-origin request must not reach grant');
  }
  let invalid=await post('/registration/options',{employeeId:'42'});
  assert.equal(invalid.status,400);
  invalid=await post('/registration/verify',{challengeId:'invalid',response:{id:'x'}});
  assert.equal(invalid.status,400);
  let started=await post('/registration/options',{});
  assert.equal(started.status,200);
  assert.equal((await started.json()).options.challenge,'AA');
  assert.equal(begins,1);
  const response=await post('/registration/verify',{
   challengeId:'d2d2d2d2-eeee-4bbb-8ddd-cccccccccccc',
   response:{id:'credential-1'}
  });
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{registered:true});
  assert.equal(finishes,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('backend denial is sanitized, not leaked to the browser',async()=>{
 const router=createFirstOwnerActivationRouter({
  origin:'http://localhost',candidate:{
   beginRegistration:async()=>{throw Object.assign(new Error('operator secret'),{status:403});},
   finishRegistration:async()=>{throw Object.assign(new Error('DB credentials'),{status:503});}
  }
 });
 const app=express();app.use('/owner',router);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const base='http://127.0.0.1:'+server.address().port+'/owner';
  const headers={'Content-Type':'application/json','Origin':'http://localhost',
   'Sec-Fetch-Site':'same-origin','X-HC-Owner-Activation':'A'.repeat(43)};
  const request=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  const a=await request('/registration/options',{});
  assert.equal(a.status,403);
  assert.doesNotMatch(await a.text(),/operator secret/);
  const b=await request('/registration/verify',{
   challengeId:'d2d2d2d2-eeee-4bbb-8ddd-cccccccccccc',response:{id:'credential-1'}
  });
  assert.equal(b.status,503);
  assert.doesNotMatch(await b.text(),/DB credentials/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('setup composer has no production activation or secret issuance fallback',()=>{
 assert.throws(()=>createIsolatedFirstOwnerSetup(),TypeError);
 assert.throws(()=>createIsolatedFirstOwnerSetup({
  environment:'production',enabled:true
 }),TypeError);
 assert.throws(()=>createIsolatedFirstOwnerSetup({
  environment:'test',enabled:true,expectedOwnerEmployeeId:'901'
 }),TypeError,'Missing trusted Timeclock and storage cannot initialize');
});
