import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createOwnerTimeclockStagingBundle,validateOwnerTimeclockStagingConfig}
 from '../services/security/ownerTimeclockStagingBundle.js';

const secret=v=>v.repeat(40);
const valid=()=>({
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_OWNER_STAGING_ENABLED:'true',
 HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'42',
 HC_OWNER_STAGING_ORIGIN:'https://owner-stage.example.test',
 HC_OWNER_STAGING_RPID:'owner-stage.example.test',
 HC_OWNER_TIMECLOCK_ORIGIN:'https://timeclock.example.test',
 HC_OWNER_TIMECLOCK_SERVICE_SECRET:secret('A'),
 HC_OWNER_SESSION_SECRET:secret('B'),
 HC_OWNER_THROTTLE_SECRET:secret('C'),
 HC_OWNER_PASSKEY_SIGNING_SECRET:secret('D'),
 HC_OWNER_APPROVAL_HMAC_SECRET:secret('E'),
 HC_OWNER_MFA_SESSION_SECRET:secret('F'),
 HC_OWNER_TOTP_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')
});
test('Owner staging preflight requires private canonical identity and independently protected HTTPS configuration',()=>{
 assert.deepEqual(validateOwnerTimeclockStagingConfig(valid()),{ready:true,issues:[]});
 for(const changes of [
  {NODE_ENV:'production'},{HC_OWNER_STAGING_ENABLED:'false'},
  {HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'901'},
  {HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'0'},
  {HC_OWNER_STAGING_ORIGIN:'http://owner-stage.example.test'},
  {HC_OWNER_STAGING_RPID:'example.test'},
  {HC_OWNER_TIMECLOCK_ORIGIN:'http://public.example.test'},
  {HC_OWNER_TIMECLOCK_ORIGIN:'https://user:pass@timeclock.example.test'},
  {HC_OWNER_TIMECLOCK_SERVICE_SECRET:''},
  {HC_OWNER_SESSION_SECRET:secret('A')},
  {HC_OWNER_TOTP_ENCRYPTION_KEY:'invalid'},
  {HC_STAGING_TEST_LOGIN_ENABLED:'true'}
 ]){
  const e={...valid(),...changes},r=validateOwnerTimeclockStagingConfig(e);
  assert.equal(r.ready,false,JSON.stringify(changes));
  assert.ok(r.issues.length>0);
  assert.throws(()=>createOwnerTimeclockStagingBundle({environment:e,pool:{connect(){}}}),TypeError);
 }
});
test('wires existing Timeclock PIN verify and canonical read to signed session with no network at construction',async()=>{
 const e=valid();
 const calls=[];
 let captured;
 const pool={connect:()=>({})};
 const bundle=createOwnerTimeclockStagingBundle({
  environment:e,pool,
  createThrottle:()=>({reserve:async()=>true}),
  createMount:args=>{
   captured=args;
   return {mount:app=>app.use('/api/staff-auth',args.loginRouter)};
  },
  fetchImpl:async(url,opts)=>{
   calls.push({url:String(url),headers:opts.headers,method:opts.method});
   const body=JSON.parse(opts.body);
   const employee={id:'42',name:'Verified Employee',canLookup:true,
    canApprove:false,permissionSource:'timeclock_employee'};
   if(url.pathname.endsWith('verify-pin')){
    assert.equal(body.pin,'1234');
    return {ok:true,json:async()=>({employee})};
   }
   assert.equal(String(body.employeeId),'42');
   return {ok:true,json:async()=>({employee})};
  }
 });
 assert.equal(calls.length,0,'construction cannot look up or modify Timeclock');
 assert.equal(captured.expectedOwnerEmployeeId,'42');
 assert.equal(captured.origin,e.HC_OWNER_STAGING_ORIGIN);
 assert.equal(captured.signingSecret,e.HC_OWNER_PASSKEY_SIGNING_SECRET);
 const app=express();bundle.mount(app);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/api/staff-auth/session',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({pin:'1234'})
  });
  assert.equal(login.status,200);
  const data=await login.json();
  assert.equal(data.employee.id,'42');
  assert.equal(data.employee.permissionSource,'timeclock_employee');
  const check=await fetch(base+'/api/staff-auth/session',{
   headers:{Authorization:'Bearer '+data.token}
  });
  assert.equal(check.status,200);
  assert.equal((await check.json()).employee.id,'42');
  const bound=await captured.staffAuthGateway.verifyBoundEmployee({
   get:name=>name==='authorization'?'Bearer '+data.token:null
  });
  assert.equal(bound.employeeId,'42');
  assert.match(bound.binding,/^[A-Za-z0-9_.:-]{16,256}$/);
  assert.equal(calls.length,3,'verify PIN, authorize signed session, and canonical recheck only');
  assert.ok(calls.every(call=>call.method==='POST'));
  assert.ok(calls.every(call=>call.headers['x-scanner-service-secret']===e.HC_OWNER_TIMECLOCK_SERVICE_SECRET));
 }finally{await new Promise(resolve=>server.close(resolve));}
});
