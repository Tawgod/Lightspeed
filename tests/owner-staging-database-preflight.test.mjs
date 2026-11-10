import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {verifyOwnerStagingDatabasePrivileges} from '../services/security/ownerStagingDatabasePreflight.js';
import {prepareOwnerStagingApp,validateOwnerStagingDatabaseUrl}
 from '../staging/owner-security-server.js';

const readyRow=()=>({
 runtime_role:'limited_owner_stage_runtime',
 ...Object.fromEntries(Array.from({length:9},(_,i)=>['t'+i,true])),
 can_issue:false,can_delete:false,can_change_digest:false,
 can_change_employee:false,can_change_expiry:false,
 can_consume:true,can_save_credential:true
});
const env=()=>({
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_OWNER_STAGING_ENABLED:'true',HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'42',
 HC_OWNER_STAGING_ORIGIN:'https://owner-stage.example.test',
 HC_OWNER_STAGING_RPID:'owner-stage.example.test',
 HC_OWNER_TIMECLOCK_ORIGIN:'https://timeclock.example.test',
 HC_OWNER_TIMECLOCK_SERVICE_SECRET:'A'.repeat(40),
 HC_OWNER_SESSION_SECRET:'B'.repeat(40),
 HC_OWNER_THROTTLE_SECRET:'C'.repeat(40),
 HC_OWNER_PASSKEY_SIGNING_SECRET:'D'.repeat(40),
 HC_OWNER_APPROVAL_HMAC_SECRET:'E'.repeat(40),
 HC_OWNER_MFA_SESSION_SECRET:'F'.repeat(40),
 HC_OWNER_TOTP_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64'),
 HC_OWNER_STAGING_DATABASE_URL:'postgres://limited_user:password@owner-db.internal/hc_owner_stage_test'
});
test('DB runtime preflight rejects issuance privileges, missing tables or authority to rewrite approvals',async()=>{
 const evaluate=async row=>{
  let released=false;
  const pool={connect:async()=>({
   query:async(sql,params)=>{
    assert.match(sql,/has_column_privilege/);
    assert.equal(params.length,9);
    return {rowCount:1,rows:[row]};
   },
   release:()=>{released=true;}
  })};
  const outcome=await verifyOwnerStagingDatabasePrivileges({pool})
   .then(v=>({ok:true,v}),()=>({ok:false}));
  assert.equal(released,true);
  return outcome.ok;
 };
 assert.equal(await evaluate(readyRow()),true);
 for(const changes of [
  {can_issue:true},{can_delete:true},{can_change_digest:true},
  {can_change_employee:true},{can_change_expiry:true},
  {can_consume:false},{can_save_credential:false},{t0:false},{t8:false},
  {runtime_role:null}
 ])assert.equal(await evaluate({...readyRow(),...changes}),false,JSON.stringify(changes));
});
test('launch requires isolated database and closes pool if schema permissions fail',async()=>{
 const valid=env();
 assert.equal(validateOwnerStagingDatabaseUrl(valid),valid.HC_OWNER_STAGING_DATABASE_URL);
 for(const change of [
  {HC_OWNER_STAGING_DATABASE_URL:'postgres://user:pass@host/railway'},
  {HC_OWNER_STAGING_DATABASE_URL:'postgres://user:pass@host/postgres'},
  {DATABASE_URL:valid.HC_OWNER_STAGING_DATABASE_URL},
  {HC_OWNER_STAGING_DATABASE_URL:'https://owner.example/test'},
  {HC_OWNER_STAGING_DATABASE_URL:''}
 ])assert.throws(()=>validateOwnerStagingDatabaseUrl({...valid,...change}),TypeError);
 let closed=false,created=false;
 const pool={connect:async()=>({}),end:async()=>{closed=true;}};
 await assert.rejects(prepareOwnerStagingApp({
  environment:valid,createPool:()=>pool,
  verifyDatabase:async()=>{throw Error('untrusted DB owner role');},
  createBundle:()=>{created=true;throw Error('must not run');}
 }),/untrusted DB owner role/);
 assert.equal(closed,true);
 assert.equal(created,false,'no external Timeclock connector before DB preflight');
});
test('complete reviewed staging composition starts only after preflight and closes disposable pool',async()=>{
 let closed=false,verified=false,mounted=false;
 const setup=await prepareOwnerStagingApp({
  environment:env(),
  createPool:()=>({connect:async()=>({}),end:async()=>{closed=true;}}),
  verifyDatabase:async()=>{verified=true;},
  createBundle:()=>{
   assert.equal(verified,true);
   return {mount:app=>{
    mounted=true;app.get('/preview',(_req,res)=>res.json({private:'stage-only'}));
   }};
  }
 });
 assert.equal(mounted,true);
 const server=await new Promise(resolve=>{
  const s=setup.app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const health=await fetch(base+'/health');
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{service:'owner-security-staging',ready:true});
  const response=await fetch(base+'/preview');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
 }finally{
  await new Promise(resolve=>server.close(resolve));
  await setup.close();
 }
 assert.equal(closed,true);
});
