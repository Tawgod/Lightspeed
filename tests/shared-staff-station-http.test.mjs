import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createStaffAuthGateway} from '../services/staffAuthGateway.js';
import {createPostgresStaffWorkstations} from '../services/security/staffWorkstationsPostgres.js';
import {createPostgresStaffLoginThrottle} from '../services/security/staffLoginThrottle.js';
import {createStaffStationProofRouter} from '../routes/staffStationProof.js';

const db=process.env.HC_TEST_DATABASE_URL;
const guarded={skip:!db?'Disposable hc_test PostgreSQL required':false};

test('HTTP workstation proof uses real signed Timeclock session and real Ed25519 device key',guarded,async()=>{
 if(!/hc_test/.test(db))throw Error('Refusing non-disposable database.');
 const pool=new pg.Pool({connectionString:db});
 const now=Date.parse('2026-11-02T16:00:00Z');
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const staffAuth=createStaffAuthGateway({
   sessionSecret:'test-only-device-http-staff-session-hmac-key-1234567',
   clock:()=>now,loginLimiter:async()=>true,
   identity:{
     verifyPin:async pin=>pin==='9182'?{id:57,name:'Test staff'}:
       Promise.reject(Object.assign(new Error('bad PIN'),{status:401})),
     authorize:async id=>Number(id)===57?{id:57,name:'Test staff'}:null
   }
 });
 const manager={strong:true};
 let approved=true;
 try{
   for(const file of ['hc_staff_auth_throttle.sql','hc_staff_stations.sql']){
     await pool.query(await fs.readFile(new URL('../db/'+file,import.meta.url),'utf8'));
   }
   const stations=createPostgresStaffWorkstations({
     pool,now:()=>now,
     signingSecret:'test-only-device-http-ticket-signing-key-12345678',
     verifyEmployeeSession:req=>staffAuth.verifyBoundEmployee(req),
     verifyStrongManager:async ctx=>ctx===manager?
       {id:8,active:true,method:'passkey',authenticatedAtMs:now-1000}:null,
     canManage:async ctx=>approved&&ctx.approverId==='8'&&
       ['staff.workstation.register','staff.workstation.revoke'].includes(ctx.operation),
     loginThrottle:createPostgresStaffLoginThrottle({
       pool,scope:'hc:staff:http-station-test',
       secret:'test-only-device-http-source-throttle-HMAC-key-123456'
     })
   });
   const registered=await stations.register({context:manager,
     publicKeySpki:publicKey.export({format:'der',type:'spki'}).toString('base64url'),
     label:'Test Chrome installation'});
   const app=express();
   app.use('/api/staff-auth',staffAuth.router);
   app.use('/staff-station',createStaffStationProofRouter({workstations:stations}));
   const server=await new Promise(resolve=>{
     const s=app.listen(0,'127.0.0.1',()=>resolve(s));
   });
   const url='http://127.0.0.1:'+server.address().port;
   const post=async(path,body,headers={})=>fetch(url+path,{
     method:'POST',headers:{'Content-Type':'application/json',...headers},
     body:JSON.stringify(body)
   });
   try{
     const noSelfEnrollment=await post('/staff-station/enroll',{publicKeySpki:'fake'});
     assert.equal(noSelfEnrollment.status,404);
     const login=await post('/api/staff-auth/session',{pin:'9182'});
     assert.equal(login.status,200);
     const signed=(await login.json()).token;
     const staffHeaders={Authorization:'Bearer '+signed};
     const forged=await post('/staff-station/challenge',{
       deviceId:registered.deviceId
     },{'X-Employee-Role':'admin','X-Verified-Device':'true'});
     assert.equal(forged.status,403);
     const badBody=await post('/staff-station/challenge',{
       deviceId:registered.deviceId,employeeId:8
     },staffHeaders);
     assert.equal(badBody.status,400);
     const issued=await post('/staff-station/challenge',{
       deviceId:registered.deviceId
     },staffHeaders);
     assert.equal(issued.status,200);
     assert.match(issued.headers.get('cache-control'),/no-store/);
     const challenge=await issued.json();
     const message=Buffer.from('hc:staff:station:v1:'+challenge.challengeId+':'+challenge.challenge);
     const signature=sign(null,message,privateKey).toString('base64url');
     const verified=await post('/staff-station/verify',{
       challengeId:challenge.challengeId,signature
     },staffHeaders);
     assert.equal(verified.status,200);
     const proof=await verified.json();
     assert.equal(proof.expiresIn,300);
     const replay=await post('/staff-station/verify',{
       challengeId:challenge.challengeId,signature
     },staffHeaders);
     assert.equal(replay.status,403);
     const checked=await fetch(url+'/staff-station/session',{headers:{
       ...staffHeaders,'X-HC-Station-Proof':proof.token
     }});
     assert.equal(checked.status,200);
     assert.equal((await checked.json()).deviceId,registered.deviceId);
     const notBound=await fetch(url+'/staff-station/session',{headers:{
       'X-HC-Station-Proof':proof.token,
       'X-Employee-Role':'admin'
     }});
     assert.equal(notBound.status,403);
     const secondLogin=await post('/api/staff-auth/session',{pin:'9182'});
     const secondToken=(await secondLogin.json()).token;
     const crossSession=await fetch(url+'/staff-station/session',{headers:{
       Authorization:'Bearer '+secondToken,'X-HC-Station-Proof':proof.token
     }});
     assert.equal(crossSession.status,403);
     approved=false;
     await assert.rejects(stations.revoke({context:manager,deviceId:registered.deviceId}),
       e=>e.code==='HC_STATION_DENIED');
     approved=true;
     await stations.revoke({context:manager,deviceId:registered.deviceId});
     const revoked=await fetch(url+'/staff-station/session',{headers:{
       ...staffHeaders,'X-HC-Station-Proof':proof.token
     }});
     assert.equal(revoked.status,403);
   }finally{await new Promise(resolve=>server.close(resolve));}
 }finally{await pool.end();}
});

test('station HTTP router cannot initialize without trusted cryptographic backend',()=>{
 assert.throws(()=>createStaffStationProofRouter(),TypeError);
});
