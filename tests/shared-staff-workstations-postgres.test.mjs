import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {createPostgresStaffWorkstations} from '../services/security/staffWorkstationsPostgres.js';
import {createPostgresStaffLoginThrottle} from '../services/security/staffLoginThrottle.js';
import {createStaffSecurityAccessGate} from '../services/security/staffSecurityBridge.js';

const db=process.env.HC_TEST_DATABASE_URL;
const guarded={skip:!db?'Disposable hc_test PostgreSQL required':false};
const denied=e=>e?.code==='HC_STATION_DENIED';
const accessDenied=e=>e?.code==='HC_STAFF_ACCESS_DENIED';

test('registered workstation signs single-use challenges and grants ONLY permitted routine access',guarded,async()=>{
 if(!/hc_test/.test(db))throw Error('Refusing anything but disposable hc_test.');
 const pool=new pg.Pool({connectionString:db,max:14});
 let clock=Date.parse('2026-11-02T14:00:00Z');
 let employeeActive=true,strongManager=false,managerGranted=true;
 const now=()=>clock;
 const staff={signed:true,employeeId:57,binding:'server-signed-session-jti-employee-57'};
 const manager={trustedManagerContext:true};
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const {privateKey:wrongPrivateKey}=generateKeyPairSync('ed25519');
 const publicKeySpki=publicKey.export({format:'der',type:'spki'}).toString('base64url');
 const signature=challenge=>sign(null,Buffer.from('hc:staff:station:v1:'+
   challenge.challengeId+':'+challenge.challenge),privateKey).toString('base64url');
 const context=()=>({...staff});
 const request=token=>({ ...context(),get:name=>
   name.toLowerCase()==='x-hc-station-proof'?token:undefined,
   headers:{'x-verified-device':'true','x-employee-role':'admin'} });
 try{
   for(const schema of ['hc_staff_auth_throttle.sql','hc_staff_stations.sql']){
     await pool.query(await fs.readFile(new URL('../db/'+schema,import.meta.url),'utf8'));
   }
   const limiter=createPostgresStaffLoginThrottle({
     pool,secret:'test-only-workstation-staff-throttle-key-123456789',
     scope:'hc:staff:station-test'
   });
   const workstations=createPostgresStaffWorkstations({
     pool,signingSecret:'test-only-workstation-session-HMAC-key-123456789',
     now,
     loginThrottle:limiter,
     verifyEmployeeSession:async ctx=>ctx?.signed===true&&employeeActive?{
       id:ctx.employeeId,active:true,binding:ctx.binding,expiresAtMs:clock+600000
     }:null,
     verifyStrongManager:async ctx=>strongManager&&ctx===manager?{
       id:8,active:true,method:'passkey',authenticatedAtMs:clock-1000
     }:null,
     canManage:async p=>managerGranted&&p.approverId==='8'&&
       ['staff.workstation.register','staff.workstation.revoke'].includes(p.operation)
   });
   assert.throws(()=>createPostgresStaffWorkstations(),TypeError);
   await assert.rejects(workstations.register({context:manager,publicKeySpki,label:'Test station'}),denied);
   strongManager=true;managerGranted=false;
   await assert.rejects(workstations.register({context:manager,publicKeySpki,label:'Test station'}),denied);
   managerGranted=true;
   await assert.rejects(workstations.register({
     context:manager,publicKeySpki:'not-an-ed25519-key',label:'Test'
   }),denied);
   const {deviceId}=await workstations.register({context:manager,publicKeySpki,label:'Test station'});
   assert.match(deviceId,/^[0-9a-f-]{36}$/);
   const saved=await pool.query('SELECT public_key_spki FROM hc_staff_stations WHERE device_id=$1',[deviceId]);
   assert.equal(saved.rows[0].public_key_spki.toString('base64url'),publicKeySpki);
   await assert.rejects(workstations.register({
     context:manager,publicKeySpki,label:'Duplicate station'
   }),e=>e?.code==='HC_STATION_UNAVAILABLE');

   await assert.rejects(workstations.beginChallenge({
     context:{...staff,signed:false},deviceId,sourceIp:'203.0.113.10'
   }),denied);
   const first=await workstations.beginChallenge({
     context:context(),deviceId,sourceIp:'203.0.113.10'
   });
   const wrong=sign(null,Buffer.from('hc:staff:station:v1:'+first.challengeId+':'+first.challenge),
     wrongPrivateKey).toString('base64url');
   await assert.rejects(workstations.completeChallenge({
     context:context(),challengeId:first.challengeId,signature:wrong
   }),denied);
   await assert.rejects(workstations.completeChallenge({
     context:context(),challengeId:first.challengeId,signature:signature(first)
   }),denied,'a failed signature consumes its challenge');

   const second=await workstations.beginChallenge({
     context:context(),deviceId,sourceIp:'203.0.113.10'
   });
   const proof=await workstations.completeChallenge({
     context:context(),challengeId:second.challengeId,signature:signature(second)
   });
   assert.equal(proof.expiresIn,300);
   assert.equal((await workstations.verify({context:context(),token:proof.token})).deviceId,deviceId);
   await assert.rejects(workstations.completeChallenge({
     context:context(),challengeId:second.challengeId,signature:signature(second)
   }),denied,'replay of accepted signature fails');
   await assert.rejects(workstations.verify({
     context:{...staff,binding:'another-signed-employee-session'},token:proof.token
   }),denied,'different signed session cannot reuse proof');

   const gate=createStaffSecurityAccessGate({
     staffSession:{
       verifyEmployeeSession:async req=>({id:String(req.employeeId),active:req.signed===true&&employeeActive}),
       verifyBaseSession:async()=>({employeeId:'57',active:true,binding:staff.binding})
     },
     mfa:{verify:async()=>{throw Error('TOTP not asserted');}},
     checkPermission:async ({operation})=>['tools.read','products.write'].includes(operation),
     verifyWorkstation:workstations.verifyWorkstation,now
   });
   const routine=await gate.authorize({request:request(proof.token),action:'tools.read'});
   assert.equal(routine.assurance,'workstation');
   await assert.rejects(gate.authorize({request:request(proof.token),action:'products.write'}),
     accessDenied,'registered station cannot authorize privileged writes');
   await assert.rejects(gate.authorize({request:request(undefined),action:'tools.read'}),
     accessDenied,'a forged trusted-device header is insufficient');

   const third=await workstations.beginChallenge({
     context:context(),deviceId,sourceIp:'203.0.113.10'
   });
   clock+=91000;
   await assert.rejects(workstations.completeChallenge({
     context:context(),challengeId:third.challengeId,signature:signature(third)
   }),denied,'expired challenge must fail');
   await assert.rejects(workstations.completeChallenge({
     context:context(),challengeId:third.challengeId,signature:signature(third)
   }),denied,'expired challenge is consumed');

   strongManager=false;
   await assert.rejects(workstations.revoke({context:manager,deviceId}),denied);
   strongManager=true;
   await workstations.revoke({context:manager,deviceId});
   await assert.rejects(workstations.verify({context:context(),token:proof.token}),
     denied,'revocation invalidates issued proof immediately');
   await assert.rejects(workstations.beginChallenge({
     context:context(),deviceId,sourceIp:'203.0.113.10'
   }),denied);
   const events=await pool.query('SELECT kind FROM hc_staff_station_events WHERE device_id=$1 ORDER BY occurred_at',[deviceId]);
   assert.deepEqual(events.rows.map(x=>x.kind),['registered','revoked']);
   await assert.rejects(pool.query('DELETE FROM hc_staff_station_events WHERE device_id=$1',[deviceId]),
     /append-only/);
   employeeActive=false;
   await assert.rejects(workstations.verify({context:context(),token:proof.token}),denied);
 }finally{await pool.end();}
});

test('station verifier rejects unbound unsigned tokens and unsupported keys without a database',()=>{
 assert.throws(()=>createPostgresStaffWorkstations({
   pool:{connect(){}},signingSecret:'short',
   verifyEmployeeSession:async()=>{},verifyStrongManager:async()=>{},
   canManage:async()=>true,loginThrottle:{reserve:async()=>true}
 }),TypeError);
});
