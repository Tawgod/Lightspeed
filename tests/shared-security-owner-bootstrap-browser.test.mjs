import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const key='OWNER-internal-one-time-bootstrap-secret-9876543210-ABCDEFGH';
async function scene({apiFails=false,cancelCeremony=false,skipRegister=false,verifyOnly=false}={}){
 const source=await readFile(new URL('../staff-passkey-client.js',import.meta.url),'utf8');
 const callbacks=new Map(),elements=new Map(),requests=[];
 function element(id){
   if(!elements.has(id))elements.set(id,{
     id,value:'',textContent:'',disabled:false,dataset:{},
     ...(id==='bootstrapKey'?{tagName:'INPUT',type:'password'}:{}),
     addEventListener(type,cb){callbacks.set(id+':'+type,cb)}
   });
   return elements.get(id);
 }
 let credentialPrompts=0;
 const context={
   document:{
     getElementById:id=>verifyOnly&&id==='bootstrapKey'?null:element(id),hidden:false,
     body:{dataset:{ownerPilotMode:verifyOnly?'verify-only':'register'}},
     addEventListener(type,cb){callbacks.set('document:'+type,cb)}
   },
   window:{addEventListener(type,cb){callbacks.set('window:'+type,cb)}},
   navigator:{credentials:{
     async create(){
       credentialPrompts++;
       assert.equal(element('bootstrapKey').value,'','the browser prompt must never retain bootstrap key in the DOM');
       if(cancelCeremony)return null;
       throw Error('not needed for this test');
     },
     async get(){throw Error('not needed')}
   }},
   fetch:async(url,opts)=>{
     requests.push({url,opts});
     if(url==='/api/staff-auth/session')return {
       ok:true,status:200,json:async()=>({token:'signed-test-session',employee:{id:'901',name:'Staging Test Owner'}})
     };
     if(url==='/staff-passkey/registration/options'){
       assert.equal(element('bootstrapKey').value,'','key must be cleared before first network request');
       if(apiFails)return {ok:false,status:403,json:async()=>({error:'Denied'})};
       return {ok:true,status:200,json:async()=>({
         challengeId:'11111111-1111-4111-8111-111111111111',
         options:{challenge:'AQIDBA',user:{id:'BQYH',name:'Staging Test Owner'},excludeCredentials:[]}
       })};
     }
     throw Error('Unexpected endpoint '+url);
   },
   Date,Uint8Array,atob,btoa,Error,String,console
 };
 vm.runInNewContext(source,context,{timeout:1000,filename:'staff-passkey-client.js'});
 async function invoke(name,type='click'){
   const cb=callbacks.get(name+':'+type);
   assert.equal(typeof cb,'function');
   await cb({preventDefault(){}});
   await new Promise(resolve=>setImmediate(resolve));
 }
 element('pin').value='1234';
 await invoke('login','submit');
 if(!verifyOnly)element('bootstrapKey').value=key;
 if(!skipRegister)await invoke('registerPasskey');
 return {elements,requests,credentialPrompts,invoke,callbacks,context};
}
test('one-time bootstrap key leaves DOM before a rejected authorization request',async()=>{
 const x=await scene({apiFails:true});
 assert.equal(x.elements.get('bootstrapKey').value,'');
 assert.equal(x.requests.length,2);
 assert.equal(x.requests[1].opts.headers['X-HC-Owner-Bootstrap-Key'],key);
 assert.equal(x.requests[0].opts.headers['X-HC-Owner-Bootstrap-Key'],undefined);
 assert.match(x.elements.get('message').textContent,/verification|approval/i);
 assert.equal(x.credentialPrompts,0);
});
test('cancelled WebAuthn prompt never leaves the one-time Owner key in the field',async()=>{
 const x=await scene({cancelCeremony:true});
 assert.equal(x.credentialPrompts,1);
 assert.equal(x.elements.get('bootstrapKey').value,'');
 assert.equal(x.requests.length,2,'cancelled ceremony must never submit registration confirmation');
 assert.match(x.elements.get('message').textContent,/cancelled/i);
 await x.invoke('signout');
 assert.equal(x.elements.get('bootstrapKey').value,'');
});

test('staging Owner pilot explains test PIN and never promises Authenticator readiness',async()=>{
 const x=await scene({skipRegister:true});
 assert.match(x.elements.get('message').textContent,/isolated test account/i);
 assert.match(x.elements.get('message').textContent,/independent Owner key/i);
 assert.doesNotMatch(x.elements.get('message').textContent,/Timeclock PIN|manager security operations/i);
});
test('switching away before registration clears an unused private Owner bootstrap key',async()=>{
 const x=await scene({skipRegister:true});
 assert.equal(x.elements.get('bootstrapKey').value,key);
 x.context.document.hidden=true;
 x.callbacks.get('document:visibilitychange')();
 assert.equal(x.elements.get('bootstrapKey').value,'');
 assert.equal(x.requests.length,1,'visibility loss cannot submit the bootstrap key or an enrollment request');
 await x.invoke('registerPasskey');
 assert.equal(x.requests.length,1,'an empty key must be reentered before registration is attempted');
 assert.match(x.elements.get('message').textContent,/independent Railway Owner bootstrap key/i);
});

test('closed Owner bootstrap page keeps authentication available but cannot send another registration request',async()=>{
 const x=await scene({verifyOnly:true,skipRegister:true});
 assert.equal(x.elements.get('registerPasskey').disabled,true);
 assert.equal(x.elements.get('verifyPasskey').disabled,false);
 assert.match(x.elements.get('message').textContent,/isolated test account/i);
 await x.invoke('registerPasskey');
 assert.equal(x.requests.length,1,'verification-only page must not call registration endpoint');
 assert.match(x.elements.get('message').textContent,/bootstrap is closed/i);
});
