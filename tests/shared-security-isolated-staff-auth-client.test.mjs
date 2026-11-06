import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const load=async fetchImpl=>{
 const code=await readFile(new URL('../staging/isolated-staff-auth-client.js',import.meta.url),'utf8');
 const window={addEventListener(name,fn){if(name==='pagehide')this.pagehide=fn;}};
 vm.runInNewContext(code,{window,fetch:fetchImpl,Error,JSON,String},{timeout:1000});
 return window;
};
test('synthetic browser session signs in with exact owner 901, memory only, validates token',async()=>{
 const reqs=[];
 const win=await load(async(url,options)=>{
   reqs.push({url,options});
   if(options.method==='POST')return {ok:true,json:async()=>({
     token:'synthetic-signed-session',employee:{id:'901',name:'Test Owner',permissionSource:'synthetic_staging_only'}
   })};
   return {ok:true,json:async()=>({employee:{id:'901',permissionSource:'synthetic_staging_only'}})};
 });
 assert.equal(win.HCStaffAuth.readSession(),null);
 await assert.rejects(win.HCStaffAuth.signIn('12'),/synthetic staging PIN/);
 assert.equal(reqs.length,0);
 const session=await win.HCStaffAuth.signIn('1234');
 assert.equal(session.employee.id,'901');
 assert.equal(win.HCStaffAuth.readSession()?.token,'synthetic-signed-session');
 assert.equal(reqs[0].url,'/api/staff-auth/session');
 assert.equal(reqs[0].options.credentials,'omit');
 assert.equal(reqs[0].options.cache,'no-store');
 assert.equal(JSON.parse(reqs[0].options.body).pin,'1234');
 assert.equal((await win.HCStaffAuth.verify()).token,session.token);
 win.pagehide();
 assert.equal(win.HCStaffAuth.readSession(),null);
});
test('identity mismatch and expired tokens fail closed without persisting a session',async()=>{
 const win=await load(async(_url,options)=>{
   if(options.method==='POST')return {ok:true,json:async()=>({
     token:'untrusted',employee:{id:'902',permissionSource:'synthetic_staging_only'}
   })};
   throw Error('GET should not occur');
 });
 await assert.rejects(win.HCStaffAuth.signIn('1234'),/Unexpected staging identity/);
 assert.equal(win.HCStaffAuth.readSession(),null);
 const okay=await load(async(_url,options)=>options.method==='POST'
   ?{ok:true,json:async()=>({token:'signed',employee:{id:'901',permissionSource:'synthetic_staging_only'}})}
   :{ok:false,status:401});
 await okay.HCStaffAuth.signIn('1234');
 assert.equal(await okay.HCStaffAuth.verify(),null);
 assert.equal(okay.HCStaffAuth.readSession(),null);
});
