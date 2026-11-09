import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createPrimaryTimeclockVerificationWiring} from '../services/security/primaryTimeclockVerificationWiring.js';

const NOW=Date.parse('2026-11-09T21:00:00Z');
const makeEmployee=()=>({
  id:'42',employeeId:'42',active:true,binding:'server-signed-staff-session-0001',
  expiresAtMs:NOW+60000
});
async function start({
  enabled=true,employee=makeEmployee(),owner=false,canonical=true
}={}){
  const called=[];
  const staffAuth={async verifyBoundEmployee(req){
    called.push('signed-session');
    if(req.get('authorization')!=='Bearer verified')throw Error('invalid signed session');
    return employee;
  }};
  const timeclockIdentity={async authorize(id){
    called.push('timeclock:'+id);
    if(!canonical)throw Object.assign(Error('revoked'),{status:403});
    return {id,permissionSource:'timeclock_employee',canLookup:true,canApprove:true};
  }};
  const checkOwnerAssignment=async({employeeId})=>{
    called.push('owner:'+employeeId);return owner;
  };
  const wiring=createPrimaryTimeclockVerificationWiring({
    staffAuth,timeclockIdentity,checkOwnerAssignment,environment:'test',
    enabled,now:()=>NOW
  });
  const app=express();app.use('/api/primary',wiring.router);
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  return {called,url:'http://127.0.0.1:'+server.address().port,
    close:()=>new Promise(resolve=>server.close(resolve))};
}
test('disabled test router does not access identity providers',async()=>{
  const s=await start({enabled:false});
  try{
    const r=await fetch(s.url+'/api/primary/self',{headers:{authorization:'Bearer verified'}});
    assert.equal(r.status,503);assert.deepEqual(s.called,[]);
  }finally{await s.close();}
});
test('test-only wiring verifies signed staff then canonical Timeclock then independent Owner assignment',async()=>{
  const s=await start({owner:true});
  try{
    const r=await fetch(s.url+'/api/primary/self',{headers:{authorization:'Bearer verified'}});
    assert.equal(r.status,200);
    const body=await r.json();
    assert.deepEqual(body,{
      readOnly:true,employeeId:'42',canonicalTimeclockIdentityVerified:true,
      independentlyAppointedOwner:true,
      nextGate:'independent-primary-factor-verification',
      enrollmentAuthorized:false
    });
    assert.deepEqual(s.called,['signed-session','timeclock:42','owner:42']);
    assert.equal(r.headers.get('cache-control'),'no-store');
  }finally{await s.close();}
});
test('primary active off-clock employee is identified without inferred Owner grant',async()=>{
  const s=await start({employee:{...makeEmployee(),clockedIn:false}});
  try{
    const r=await fetch(s.url+'/api/primary/self',{headers:{authorization:'Bearer verified'}});
    assert.equal(r.status,200);
    const body=await r.json();
    assert.equal(body.independentlyAppointedOwner,false);
    assert.equal(body.nextGate,'independent-owner-commissioning');
    assert.equal(body.enrollmentAuthorized,false);
  }finally{await s.close();}
});
test('missing session never reaches Timeclock or Owner lookup',async()=>{
  const s=await start();
  try{
    const r=await fetch(s.url+'/api/primary/self');
    assert.equal(r.status,403);
    assert.deepEqual(s.called,['signed-session']);
  }finally{await s.close();}
});
test('revoked canonical employee never reaches Owner assignment',async()=>{
  const s=await start({canonical:false});
  try{
    const r=await fetch(s.url+'/api/primary/self',{headers:{authorization:'Bearer verified'}});
    assert.equal(r.status,503);
    assert.deepEqual(s.called,['signed-session','timeclock:42']);
  }finally{await s.close();}
});
test('staging synthetic identity 901 cannot pass canonical production employee check',async()=>{
  const s=await start({employee:{...makeEmployee(),id:'901',employeeId:'901'},canonical:false});
  try{
    const r=await fetch(s.url+'/api/primary/self',{headers:{authorization:'Bearer verified'}});
    assert.notEqual(r.status,200);
    assert.equal(s.called.includes('owner:901'),false);
  }finally{await s.close();}
});
test('no write route, employee selector or deployment side effect',async()=>{
  const s=await start();
  try{
    const url=s.url+'/api/primary';
    for(const [method,path] of [['POST','/self'],['POST','/enroll'],['PATCH','/owner'],['GET','/employee/42']]){
      const r=await fetch(url+path,{method});
      assert.equal(r.status,404);
    }
    assert.deepEqual(s.called,[]);
  }finally{await s.close();}
});
test('factory fails closed outside test mode or without trusted adapters',()=>{
  const staffAuth={verifyBoundEmployee:async()=>makeEmployee()};
  const timeclockIdentity={authorize:async()=>({})};
  const checkOwnerAssignment=async()=>false;
  assert.throws(()=>createPrimaryTimeclockVerificationWiring(),TypeError);
  for(const environment of ['production','isolated-staging',undefined]){
    assert.throws(()=>createPrimaryTimeclockVerificationWiring({
      staffAuth,timeclockIdentity,checkOwnerAssignment,environment,enabled:true
    }),TypeError);
  }
  assert.throws(()=>createPrimaryTimeclockVerificationWiring({
    staffAuth,timeclockIdentity,checkOwnerAssignment:null,environment:'test'
  }),TypeError);
});
