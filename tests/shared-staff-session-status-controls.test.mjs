import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../staff-security-client.js',import.meta.url),'utf8');
function harness(){
 const callbacks=new Map(),elems=new Map(),calls=[];
 const element=id=>{
  if(!elems.has(id))elems.set(id,{
   value:'',textContent:'',hidden:false,disabled:false,
   removeAttribute(key){delete this[key]},
   addEventListener(kind,callback){callbacks.set(id+':'+kind,callback)}
  });return elems.get(id);
 };
 let now=2000000000000,sessionMode='active',mfaMode='active',current=null;
 const identity={id:'901',name:'Staging Test Owner',permissionSource:'synthetic_staging_only'};
 const auth={
  verify:async()=>null,signIn:async()=>{
   current={token:'signed-staging-session',employee:identity};return current;
  },readSession:()=>current,signOut:()=>{current=null;}
 };
 const fetch=async(url,init)=>{
  calls.push({url,init});
  if(url==='/api/staff-auth/session'){
   if(sessionMode==='expired')return {ok:false,status:401,json:async()=>({error:'expired'})};
   if(sessionMode==='outage')return {ok:false,status:503,json:async()=>({error:'unavailable'})};
   if(sessionMode==='mismatch')return {ok:true,status:200,json:async()=>({ok:true,employee:{id:'902',permissionSource:'synthetic_staging_only'}})};
   return {ok:true,status:200,json:async()=>({ok:true,employee:identity})};
  }
  if(url==='/staff-security/api/mfa/session'){
   if(init.method==='POST')return {ok:true,status:200,json:async()=>({token:'part.sig',expiresIn:300})};
   if(mfaMode==='expired')return {ok:false,status:401,json:async()=>({error:'expired'})};
   return {ok:true,status:200,json:async()=>({verified:true,method:'totp'})};
  }
  if(url==='/staff-security/api/enrollment-request')return {ok:true,status:200,json:async()=>({state:'none'})};
  if(url==='/staff-security/api/authenticator')return {ok:true,status:200,json:async()=>({state:'active'})};
  throw Error('Unexpected route '+url);
 };
 const context={
  window:{HCStaffAuth:auth,addEventListener(kind,fn){callbacks.set('window:'+kind,fn)}},
  document:{getElementById:element,hidden:false,addEventListener(kind,fn){callbacks.set('document:'+kind,fn)}},
  Date:class extends Date{static now(){return now;}},fetch,
  navigator:{clipboard:{writeText:async()=>{}}},console
 };
 vm.runInNewContext(source,context,{filename:'staff-security-client.js',timeout:1000});
 const call=id=>callbacks.get(id+':click')();
 return {
  element,calls,auth,call,
  setSessionMode:v=>sessionMode=v,setMfaMode:v=>mfaMode=v,
  setNow:v=>now=v,
  signIn:async()=>{
   element('employeePin').value='1234';
   await callbacks.get('signInForm:submit')({preventDefault(){}});
  },
  verifyMfa:async()=>{
   element('mfaCode').value='123456';
   await callbacks.get('mfaForm:submit')({preventDefault(){}});
  }
 };
}
test('employee status button verifies the existing signed session via GET without refreshing it',async()=>{
 const h=harness();
 assert.equal(h.element('checkEmployeeSession').disabled,true);
 await h.signIn();
 assert.equal(h.element('checkEmployeeSession').disabled,false);
 await h.call('checkEmployeeSession');
 assert.equal(h.element('sessionState').textContent,'Active');
 assert.match(h.element('employeeSessionMessage').textContent,/does not extend/i);
 const req=h.calls.filter(x=>x.url==='/api/staff-auth/session');
 assert.equal(req.length,1);
 assert.equal(req[0].init.method,'GET');
 assert.equal(req[0].init.headers.Authorization,'Bearer signed-staging-session');
 assert.equal(req[0].init.body,undefined);
});
test('combined check verifies base and MFA from existing proofs in the same action',async()=>{
 const h=harness();await h.signIn();await h.verifyMfa();await h.call('checkAllSessions');
 assert.equal(h.element('sessionState').textContent,'Active');
 assert.equal(h.element('mfaState').textContent,'Verified');
 assert.match(h.element('mfaStatusMessage').textContent,/Server confirmed/);
 const checks=h.calls.filter(x=>x.init?.method==='GET' && (x.url==='/api/staff-auth/session' || x.url==='/staff-security/api/mfa/session'));
 assert.equal(checks.length,2);
 assert.equal(checks[0].url,'/api/staff-auth/session');
 assert.equal(checks[1].url,'/staff-security/api/mfa/session');
 assert.equal(checks[1].init.headers['x-hc-mfa-session'],'part.sig');
});
test('combined check shows five-minute proof expired while signed employee session stays active',async()=>{
 const h=harness();await h.signIn();await h.verifyMfa();
 h.setNow(2000000300000);
 await h.call('checkAllSessions');
 assert.equal(h.element('sessionState').textContent,'Active');
 assert.equal(h.element('mfaState').textContent,'Expired');
 assert.equal(h.element('checkMfaStatus').disabled,true);
});
test('expired employee session clears MFA proof and allows PIN reauthentication',async()=>{
 const h=harness();await h.signIn();await h.verifyMfa();
 h.setSessionMode('expired');await h.call('checkAllSessions');
 assert.equal(h.element('sessionState').textContent,'Expired');
 assert.equal(h.element('mfaState').textContent,'Not verified');
 assert.equal(h.element('checkEmployeeSession').disabled,true);
 assert.equal(h.element('checkAllSessions').disabled,true);
 assert.equal(h.element('signInForm').hidden,false);
 assert.match(h.element('employeeSessionMessage').textContent,/expired or revoked/);
 assert.equal(h.calls.filter(x=>x.url==='/staff-security/api/mfa/session'&&x.init.method==='GET').length,0);
});
test('temporary backend outage does not incorrectly mark employee session expired',async()=>{
 const h=harness();await h.signIn();h.setSessionMode('outage');
 await h.call('checkEmployeeSession');
 assert.equal(h.element('sessionState').textContent,'Signed in');
 assert.match(h.element('employeeSessionMessage').textContent,/could not be checked/i);
 assert.equal(h.element('checkEmployeeSession').disabled,false);
});
test('mismatched employee response fails closed',async()=>{
 const h=harness();await h.signIn();h.setSessionMode('mismatch');
 await h.call('checkEmployeeSession');
 assert.equal(h.element('sessionState').textContent,'Not verified');
 assert.equal(h.element('checkAllSessions').disabled,true);
 assert.equal(h.auth.readSession(),null);
});
