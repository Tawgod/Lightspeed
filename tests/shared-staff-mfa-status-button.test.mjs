import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../staff-security-client.js',import.meta.url),'utf8');
async function setup(){
 const callbacks=new Map(),elems=new Map(),calls=[];
 let now=2000000000000,mode='valid';
 const element=id=>{
  if(!elems.has(id))elems.set(id,{
   value:'',textContent:'',hidden:false,disabled:false,
   removeAttribute(field){delete this[field]},
   addEventListener(kind,fn){callbacks.set(id+':'+kind,fn)}
  });
  return elems.get(id);
 };
 const account={token:'bound-base-token',employee:{id:'901',name:'Staging Test Owner'}};
 const auth={verify:async()=>null,readSession:()=>account,signOut:()=>{},signIn:async()=>account};
 const window={HCStaffAuth:auth,addEventListener(kind,fn){callbacks.set('window:'+kind,fn)}};
 const document={getElementById:element,addEventListener(kind,fn){callbacks.set('document:'+kind,fn)},hidden:false};
 const DateStub=class extends Date{static now(){return now;}};
 const fetch=async(url,init)=>{
  calls.push({url,init});
  if(url==='/staff-security/api/mfa/session' && init.method==='POST')
   return {ok:true,status:200,json:async()=>({token:'abc.def',expiresIn:300})};
  if(url==='/staff-security/api/mfa/session' && init.method==='GET'){
   if(mode==='unauthorized')return {ok:false,status:401,json:async()=>({error:'expired'})};
   if(mode==='unavailable')return {ok:false,status:503,json:async()=>({error:'backend error'})};
   return {ok:true,status:200,json:async()=>({verified:true,method:'totp'})};
  }
  throw Error('Unexpected request '+url);
 };
 vm.runInNewContext(source,{window,document,Date:DateStub,fetch,navigator:{clipboard:{}},console},{filename:'staff-security-client.js',timeout:1000});
 await Promise.resolve();
 const verify=async()=>{
  element('mfaCode').value='123456';
  await callbacks.get('mfaForm:submit')({preventDefault(){}});
 };
 const check=()=>callbacks.get('checkMfaStatus:click')();
 return {element,calls,verify,check,setNow:n=>now=n,setMode:v=>mode=v};
}
test('check verification calls the server with only a signed bound proof; does not request a new OTP',async()=>{
 const s=await setup();
 assert.equal(s.element('checkMfaStatus').disabled,true);
 await s.verify();
 assert.equal(s.element('checkMfaStatus').disabled,false);
 await s.check();
 assert.equal(s.element('mfaState').textContent,'Verified');
 assert.match(s.element('mfaStatusMessage').textContent,/Server confirmed/);
 assert.equal(s.calls.length,2);
 assert.equal(s.calls[1].url,'/staff-security/api/mfa/session');
 assert.equal(s.calls[1].init.method,'GET');
 assert.equal(s.calls[1].init.headers.Authorization,'Bearer bound-base-token');
 assert.equal(s.calls[1].init.headers['x-hc-mfa-session'],'abc.def');
 assert.equal(s.calls[1].init.body,undefined);
});
test('server rejects old verification and clears proof without showing a raw token',async()=>{
 const s=await setup();await s.verify();s.setMode('unauthorized');
 await s.check();
 assert.equal(s.element('mfaState').textContent,'Expired');
 assert.equal(s.element('checkMfaStatus').disabled,true);
 assert.match(s.element('mfaStatusMessage').textContent,/expired or revoked/i);
 assert.doesNotMatch(s.element('mfaStatusMessage').textContent,/abc\.def/);
});
test('local five-minute limit expires proof without sending an expired token to the server',async()=>{
 const s=await setup();await s.verify();s.setNow(2000000300000);
 await s.check();
 assert.equal(s.element('mfaState').textContent,'Expired');
 assert.equal(s.element('checkMfaStatus').disabled,true);
 assert.equal(s.calls.length,1);
});
test('temporary 503 cannot claim an expired or active server session',async()=>{
 const s=await setup();await s.verify();s.setMode('unavailable');
 await s.check();
 assert.match(s.element('mfaStatusMessage').textContent,/Could not check/);
 assert.doesNotMatch(s.element('mfaStatusMessage').textContent,/Server confirmed/);
});
