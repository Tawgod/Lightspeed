import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createCipheriv,randomBytes} from 'node:crypto';
import {generateStaffTotpSecret,matchStaffTotpStep} from '../services/security/staffTotp.js';
import {createPostgresStaffTotp} from '../services/security/staffTotpPostgres.js';
import {createStaffMfaSessions} from '../services/security/staffMfaSessions.js';
import {createScannerSessions} from '../services/scannerSessions.js';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function bytes(secret){
 let value=0,bits=0,out=[];
 for(const ch of secret){value=(value<<5)|alphabet.indexOf(ch);bits+=5;
  if(bits>=8){out.push((value>>>(bits-=8))&255);value&=(1<<bits)-1;}}
 return Buffer.from(out);
}
function totp(secret,step){
 const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(step));
 const mac=createHmac('sha1',bytes(secret)).update(b).digest();
 const off=mac[mac.length-1]&15;
 return String((mac.readUInt32BE(off)&0x7fffffff)%1_000_000).padStart(6,'0');
}
function encrypted(secret,key,id){
 const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',key,nonce);
 c.setAAD(Buffer.from('hc:staff:totp:'+id));
 return Buffer.concat([nonce,c.getAuthTag(),c.update(secret,'utf8'),c.final()]);
}
test('TOTP accepts adjacent time steps but rejects a code after its clock tolerance expires',()=>{
 const secret=generateStaffTotpSecret(),step=2000000;
 const code=totp(secret,step);
 assert.equal(matchStaffTotpStep({secret,code,nowMs:step*30000}),step);
 assert.equal(matchStaffTotpStep({secret,code,nowMs:(step+1)*30000}),step);
 assert.equal(matchStaffTotpStep({secret,code,nowMs:(step+2)*30000}),null);
});
test('PostgreSQL TOTP verification reserves each step exactly once and rejects replay',async()=>{
 const secret=generateStaffTotpSecret(),key=randomBytes(32);
 let current=2000000*30000,step=-1,throttles=0;
 const pool={async connect(){return {
  async query(sql,args=[]){
   if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
   if(sql.includes('SELECT secret_ciphertext,last_used_step,status'))
    return {rowCount:1,rows:[{secret_ciphertext:encrypted(secret,key,'901'),last_used_step:step,status:'active'}]};
   if(sql.includes('UPDATE hc_staff_totp SET last_used_step=')){
    if(step>=args[1])return {rowCount:0,rows:[]};
    step=args[1];return {rowCount:1,rows:[{employee_id:'901'}]};
   }
   throw Error('Unexpected SQL');
  },release(){}
 };}};
 const verifier=createPostgresStaffTotp({
  pool,encryptionKey:key,
  verifyEmployeeSession:async()=>({id:'901',active:true}),
  authorizeEnrollment:async()=>false,
  loginThrottle:{reserve:async()=>{throttles++;return true}},
  now:()=>current
 });
 const code=totp(secret,2000000);
 const result=await verifier.verifyCode({context:{},code,sourceIp:'127.0.0.1'});
 assert.equal(result.verified,true);
 await assert.rejects(verifier.verifyCode({context:{},code,sourceIp:'127.0.0.1'}),
  err=>err.status===401);
 assert.equal(throttles,2);
 current+=60000;
 await assert.rejects(verifier.verifyCode({context:{},code,sourceIp:'127.0.0.1'}),
  err=>err.status===401);
 const next=totp(secret,2000002);
 assert.equal((await verifier.verifyCode({context:{},code:next,sourceIp:'127.0.0.1'})).verified,true);
 assert.equal(step,2000002);
});
test('signed MFA proof expires at five minutes, is bound to original staff session and factor',async()=>{
 let now=2000000000000,binding='0123456789abcdef0123456789abcdef';
 let generation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const context={};
 const totp={
  verifyCode:async()=>({verified:true,employeeId:'901',method:'totp',authenticatedAtMs:now}),
  getActiveGeneration:async()=>generation
 };
 const mfa=createStaffMfaSessions({
  secret:'test-only-independent-mfa-signing-secret-12345',
  totp,verifyBaseSession:async()=>({employeeId:'901',active:true,binding}),
  now:()=>now
 });
 const proof=await mfa.authenticate({context,code:'123456',sourceIp:'127.0.0.1'});
 assert.equal(proof.expiresIn,300);
 assert.equal((await mfa.verify({context,token:proof.token})).verified,true);
 now+=300000;
 await assert.rejects(mfa.verify({context,token:proof.token}),err=>err.status===401);
 now-=300000;binding='fedcba9876543210fedcba9876543210';
 await assert.rejects(mfa.verify({context,token:proof.token}),err=>err.status===401);
 binding='0123456789abcdef0123456789abcdef';
 generation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 await assert.rejects(mfa.verify({context,token:proof.token}),err=>err.status===401);
});
test('signed synthetic PIN session expires after 15 minutes and bound verifier refuses it',()=>{
 let now=2000000000000;
 const sessions=createScannerSessions({secret:'test-only-independent-base-session-key-123456',now:()=>now,ttlSeconds:900});
 const token=sessions.issue({id:'901'});
 assert.equal(sessions.verifyBound(token).employeeId,901);
 now+=900000;
 assert.throws(()=>sessions.verifyBound(token),err=>err.status===401);
});
