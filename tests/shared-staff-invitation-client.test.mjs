import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('staff invitation fragment disappears before employee PIN sign-in and is redeemed once',async()=>{
 const source=await readFile(new URL('../staff-security-client.js',import.meta.url),'utf8');
 const callbacks=new Map(),elements=new Map(),requests=[];
 const token='A'.repeat(43);
 let cleaned=false;
 const byId=id=>{
   if(!elements.has(id))elements.set(id,{
     value:'',textContent:'',hidden:false,disabled:false,
     removeAttribute(field){delete this[field];},
     addEventListener(k,fn){callbacks.set(id+':'+k,fn);}
   });
   return elements.get(id);
 };
 let current=null;
 const account={token:'signed-timeclock-employee-session',
   employee:{id:58,name:'Synthetic Staff'}};
 const staffAuth={
   readSession:()=>current,verify:async()=>null,
   signIn:async(pin)=>{assert.equal(pin,'9183');current=account;return current;},
   signOut:()=>{current=null;}
 };
 const env={
   window:{
     HCStaffAuth:staffAuth,
     location:{hash:'#invite='+token,pathname:'/staff-security/',search:''},
     history:{replaceState(_state,_unused,url){
       assert.equal(url,'/staff-security/');cleaned=true;
     }},
     addEventListener(k,fn){callbacks.set('window:'+k,fn);}
   },
   document:{getElementById:byId,
     addEventListener(k,fn){callbacks.set('document:'+k,fn);},hidden:false},
   navigator:{clipboard:{writeText:async()=>{}}},
   fetch:async(url,init)=>{
     assert.equal(cleaned,true,'Invite fragment must be removed before networking');
     requests.push({url,init});
     const response=url==='/staff-enrollment-invites/redeem'
       ?{requestId:'11111111-1111-4111-8111-111111111111',state:'requested',
          expiresAtMs:Date.now()+300000}
       :url.endsWith('/api/enrollment-request')
       ?{requestId:'11111111-1111-4111-8111-111111111111',state:'requested',
          expiresAtMs:Date.now()+300000}
       :url.endsWith('/api/authenticator')?{state:'not_enrolled'}:{};
     return {ok:true,status:200,json:async()=>response};
   },
   Date,console
 };
 vm.runInNewContext(source,env,{filename:'staff-security-client.js',timeout:1000});
 assert.equal(cleaned,true);
 byId('employeePin').value='9183';
 const cb=callbacks.get('signInForm:submit');
 assert.equal(typeof cb,'function');
 await cb({preventDefault(){}});
 const calls=requests.filter(x=>x.url==='/staff-enrollment-invites/redeem');
 assert.equal(calls.length,1);
 assert.equal(JSON.parse(calls[0].init.body).token,token);
 assert.equal(calls[0].init.headers.Authorization,'Bearer '+account.token);
 assert.equal(byId('approvalState').textContent,'Awaiting manager');
 assert.equal(byId('employeePin').value,'');
 assert.equal(byId('startEnrollment').disabled,true);
 const check=callbacks.get('checkApproval:click');
 await check();
 assert.equal(requests.filter(x=>x.url==='/staff-enrollment-invites/redeem').length,1,
   'Refreshing status does not replay the link');
});
