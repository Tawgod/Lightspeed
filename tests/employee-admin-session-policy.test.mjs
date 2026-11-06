import test from 'node:test';
import assert from 'node:assert/strict';
import {
 DEFAULT_STAFF_SESSION_POLICY,validateStaffSessionPolicy,
 classifyStaffDevice,previewStaffSessionPolicy
} from '../services/security/adminSessionPolicy.js';

test('policy baseline preserves current 15-minute sessions for both classes',()=>{
 const saved=validateStaffSessionPolicy(DEFAULT_STAFF_SESSION_POLICY);
 assert.equal(saved.remote.absoluteSeconds,900);
 assert.equal(saved['approved-workstation'].absoluteSeconds,900);
 assert.equal(Object.isFrozen(saved),true);
});
test('reject invalid, excessive, incomplete and client-provided policy values',()=>{
 const base=structuredClone(DEFAULT_STAFF_SESSION_POLICY);
 for(const invalid of [
   {...base,remote:{idleSeconds:901,absoluteSeconds:900}},
   {...base,remote:{idleSeconds:900,absoluteSeconds:999999}},
   {...base,remote:{idleSeconds:0,absoluteSeconds:900}},
   {...base,remote:{idleSeconds:'900',absoluteSeconds:900}},
   {...base,remote:{idleSeconds:900,absoluteSeconds:900,owner:true}},
   {...base,remote:{idleSeconds:900,absoluteSeconds:900},unknown:{}},
   {remote:base.remote},
   null,{}
 ]){
   assert.throws(()=>validateStaffSessionPolicy(invalid),TypeError);
 }
});
test('different approved local and remote policies can be previewed without any writes',()=>{
 const next={
  'approved-workstation':{idleSeconds:1800,absoluteSeconds:28800},
  remote:{idleSeconds:900,absoluteSeconds:3600}
 };
 const diff=previewStaffSessionPolicy({next});
 assert.equal(diff.length,2);
 assert.ok(diff.every(x=>x.changed));
 assert.equal(diff[0].after.absoluteSeconds,28800);
 assert.equal(DEFAULT_STAFF_SESSION_POLICY['approved-workstation'].absoluteSeconds,900);
});
test('device classification never accepts client claim, address or station identifier alone',()=>{
 assert.equal(classifyStaffDevice({local:true,ip:'127.0.0.1'}),'remote');
 assert.equal(classifyStaffDevice({stationProof:{verified:false,deviceId:'station',expiresAtMs:Date.now()+20000}}),'remote');
 assert.equal(classifyStaffDevice({stationProof:{verified:true,deviceId:'station',expiresAtMs:Date.now()-20000}}),'remote');
 assert.equal(classifyStaffDevice({stationProof:{verified:true,deviceId:'station',expiresAtMs:Date.now()+20000}}),'approved-workstation');
});
