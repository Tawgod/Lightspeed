import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../staging/isolated-admin-auth-client.js',import.meta.url),'utf8');
function setup(){
 const handlers=new Map(),elements=new Map(),requests=[];
 const element=id=>{
  if(!elements.has(id))elements.set(id,{
   value:'',hidden:true,textContent:'',
   addEventListener(kind,handler){handlers.set(id+':'+kind,handler)}
  });
  return elements.get(id);
 };
 const windowEvents=new Map(),docEvents=new Map();let now=2000000000000;const emitted=[];
 const fakeWindow={
  addEventListener(name,handler){windowEvents.set(name,handler)},
  dispatchEvent(event){emitted.push(event.type);const handler=windowEvents.get(event.type);if(handler)handler(event)}
 };
 const document={
  getElementById:element,
  addEventListener(name,handler){docEvents.set(name,handler)},hidden:false
 };
 let mode='ok';
 async function fetch(url,options){
  requests.push({url,options});
  const good={ok:true,status:200,json:async()=>({
   ...(url==='/api/staff-auth/session'
     ?{token:'signed.synthetic',employee:{id:'901',permissionSource:'synthetic_staging_only'}}
     :{token:'proof.signed',expiresIn:300})
  })};
  if(mode==='reject')return {ok:false,status:401,json:async()=>({})};
  return good;
 }
 vm.runInNewContext(source,{
  window:fakeWindow,document,fetch,Date:class extends Date{static now(){return now;}},
  Event:class {constructor(type){this.type=type}},
  navigator:{},console
 },{timeout:1000});
 return {element,handlers,requests,docEvents,document,window:fakeWindow,emitted,setMode:m=>mode=m,setNow:n=>now=n};
}
test('isolated admin login never grants PIN-only access; TOTP proof stays memory-only',async()=>{
 const h=setup();
 assert.equal(h.window.HCAdminAuth.getProof(),null);
 assert.equal(h.requests.length,0);
 h.element('adminTestPin').value='1234';
 await h.handlers.get('adminTestSignIn:submit')({preventDefault(){}});
 assert.equal(h.window.HCAdminAuth.getProof(),null);
 assert.equal(h.element('adminTestTotp').hidden,false);
 h.element('adminTestCode').value='123456';
 await h.handlers.get('adminTestTotp:submit')({preventDefault(){}});
 const proof=h.window.HCAdminAuth.getProof();
 assert.equal(proof.baseToken,'signed.synthetic');
 assert.equal(proof.factorToken,'proof.signed');
 assert.equal(proof.factorType,'totp');
 assert.equal(h.element('adminTestCode').value,'');
 assert.deepEqual(h.requests.map(r=>r.url),[
  '/api/staff-auth/session','/staff-security/api/mfa/session'
 ]);
 assert.equal(h.requests[1].options.headers.Authorization,'Bearer signed.synthetic');
});
test('brief tab switch hides dashboard but retains unexpired proof for server recheck',async()=>{
 const h=setup();
 h.element('adminTestPin').value='1234';
 await h.handlers.get('adminTestSignIn:submit')({preventDefault(){}});
 h.element('adminTestCode').value='123456';
 await h.handlers.get('adminTestTotp:submit')({preventDefault(){}});
 const token=h.window.HCAdminAuth.getProof().factorToken;
 h.document.hidden=true;
 h.docEvents.get('visibilitychange')();
 assert.equal(h.window.HCAdminAuth.getProof().factorToken,token);
 assert.equal(h.emitted.at(-1),'hc-admin-suspended');
 h.setNow(2000000001000);
 h.document.hidden=false;
 h.docEvents.get('visibilitychange')();
 assert.equal(h.emitted.at(-1),'hc-admin-authenticated');
 assert.match(h.element('adminAuthMessage').textContent,/checking current/i);
 assert.equal(h.window.HCAdminAuth.getProof().factorToken,token);
 h.handlers.get('adminSignOut:click')();
 assert.equal(h.window.HCAdminAuth.getProof(),null);
});
test('return after five-minute proof expiry keeps PIN sign-in but requires fresh factor',async()=>{
 const h=setup();
 h.element('adminTestPin').value='1234';
 await h.handlers.get('adminTestSignIn:submit')({preventDefault(){}});
 h.element('adminTestCode').value='123456';
 await h.handlers.get('adminTestTotp:submit')({preventDefault(){}});
 h.document.hidden=true;h.docEvents.get('visibilitychange')();
 h.setNow(2000000300001);
 h.document.hidden=false;h.docEvents.get('visibilitychange')();
 assert.equal(h.window.HCAdminAuth.getProof(),null);
 assert.equal(h.emitted.at(-1),'hc-admin-signed-out');
 assert.match(h.element('adminAuthMessage').textContent,/verification expired/i);
 assert.equal(h.element('adminTestSignIn').hidden,true);
 assert.equal(h.element('adminTestTotp').hidden,false);
});
test('failed second-factor check never opens admin',async()=>{
 const h=setup();
 h.element('adminTestPin').value='1234';
 await h.handlers.get('adminTestSignIn:submit')({preventDefault(){}});
 h.setMode('reject');h.element('adminTestCode').value='123456';
 await h.handlers.get('adminTestTotp:submit')({preventDefault(){}});
 assert.equal(h.window.HCAdminAuth.getProof(),null);
 assert.ok(!h.emitted.includes('hc-admin-authenticated'));
});
