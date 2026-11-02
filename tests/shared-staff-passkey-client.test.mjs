import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('native browser passkey enrollment, authentication, manager proof and memory-only cleanup',async()=>{
 const source=await readFile(new URL('../staff-passkey-client.js',import.meta.url),'utf8');
 const callbacks=new Map(),els=new Map();
 const node=id=>{
   if(!els.has(id))els.set(id,{
     id,value:'',textContent:'',disabled:false,dataset:{},
     addEventListener(kind,fn){callbacks.set(id+':'+kind,fn);}
   });
   return els.get(id);
 };
 const requests=[],seen={},challenge='AQIDBA',userId='BQYH';
 const bytes=n=>Uint8Array.from(n).buffer;
 const fake={
   id:'cGFzc2tleS1maXh0dXJl',rawId:bytes([1,2,3]),type:'public-key',
   response:{
     attestationObject:bytes([4,5]),
     authenticatorData:bytes([6,7]),
     clientDataJSON:bytes([8,9]),
     signature:bytes([10,11]),
     userHandle:null,
     getTransports(){return ['internal']}
   },
   getClientExtensionResults(){return {}}
 };
 let hidden=false;
 const context={
   document:{getElementById:node,get hidden(){return hidden;},
     addEventListener(k,fn){callbacks.set('document:'+k,fn);}},
   window:{addEventListener(k,fn){callbacks.set('window:'+k,fn);}},
   navigator:{credentials:{
     async create({publicKey}){
       seen.registration=publicKey;
       return fake;
     },
     async get({publicKey}){
       seen.authentication=publicKey;
       return fake;
     }
   }},
   fetch:async(url,init)=>{
     requests.push({url,init});
     const data={
       '/api/staff-auth/session':{token:'signed-employee',employee:{id:57,name:'Test Manager'}},
       '/staff-passkey/registration/options':{
         challengeId:'11111111-1111-4111-8111-111111111111',
         options:{challenge,user:{id:userId,name:'Employee'},excludeCredentials:[]}
       },
       '/staff-passkey/registration/verify':{registered:true},
       '/staff-passkey/authentication/options':{
         challengeId:'22222222-2222-4222-8222-222222222222',
         options:{challenge,allowCredentials:[],userVerification:'required'}
       },
       '/staff-passkey/authentication/verify':{token:'aBc.xYz',expiresIn:300},
       '/staff-security/api/enrollment-approve':{approved:true}
     };
     return {ok:true,status:200,json:async()=>data[url]};
   },
   Date,atob,btoa,Uint8Array,String,Error,console
 };
 vm.runInNewContext(source,context,{filename:'staff-passkey-client.js',timeout:1000});
 const run=async(id,kind='click')=>{
   const cb=callbacks.get(id+':'+kind);
   assert.equal(typeof cb,'function');
   await cb({preventDefault(){}});
   await new Promise(ok=>setImmediate(ok));
 };
 assert.equal(node('registerPasskey').disabled,true);
 node('pin').value='9182';
 await run('login','submit');
 assert.equal(node('registerPasskey').disabled,false);
 assert.equal(requests[0].url,'/api/staff-auth/session');
 assert.equal(node('pin').value,'');
 await run('registerPasskey');
 assert.deepEqual(Array.from(seen.registration.challenge),[1,2,3,4]);
 assert.deepEqual(Array.from(seen.registration.user.id),[5,6,7]);
 const register=requests.find(x=>x.url==='/staff-passkey/registration/verify');
 assert.equal(JSON.parse(register.init.body).response.rawId,'AQID');
 assert.equal(register.init.headers.Authorization,'Bearer signed-employee');
 await run('verifyPasskey');
 assert.deepEqual(Array.from(seen.authentication.challenge),[1,2,3,4]);
 const assertion=requests.find(x=>x.url==='/staff-passkey/authentication/verify');
 assert.equal(JSON.parse(assertion.init.body).response.signature,'Cgs');
 assert.equal(node('managerApproval').disabled,false);
 node('requestId').value='33333333-3333-4333-8333-333333333333';
 await run('managerApproval');
 const approval=requests.find(x=>x.url==='/staff-security/api/enrollment-approve');
 assert.equal(approval.init.headers['X-HC-Passkey-Proof'],'aBc.xYz');
 assert.equal(approval.init.headers.Authorization,'Bearer signed-employee');
 assert.equal(JSON.parse(approval.init.body).requestId,node('requestId').value);
 hidden=true;
 callbacks.get('document:visibilitychange')();
 assert.equal(node('managerApproval').disabled,true,'proof removed when hidden');
 assert.equal(node('proof').textContent,'Not verified');
 await run('signout');
 assert.equal(node('identity').textContent,'Not signed in');
 assert.equal(node('registerPasskey').disabled,true);
 assert.ok(!source.includes('localStorage.setItem'));
 assert.ok(!source.includes('sessionStorage.setItem'));
});
