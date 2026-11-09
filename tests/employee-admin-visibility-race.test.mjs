import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const client=await readFile(new URL('../admin/employee-admin-client.js',import.meta.url),'utf8');
test('late settings response after tab leave cannot reopen protected owner dashboard',async()=>{
 const elements=new Map(),callbacks=new Map();
 const element=id=>{
  if(!elements.has(id))elements.set(id,{
   hidden:id==='workspace',textContent:'',value:'',
   replaceChildren(){},append(){},
   addEventListener(kind,callback){callbacks.set(id+':'+kind,callback)}
  });
  return elements.get(id);
 };
 let resolveSettings,requests=0,verified=true;
 const actions=new Map();
 const window={
  HCAdminAuth:{getProof:()=>verified?{
   baseToken:'session.test',factorToken:'proof.test',factorType:'totp'
  }:null},
  addEventListener:(name,fn)=>actions.set(name,fn),
  confirm:()=>true
 };
 const document={
  hidden:false,getElementById:element,
  createElement:()=>({append(){},textContent:'',className:''})
 };
 const fetch=async url=>{
  requests++;
  if(url.endsWith('/api/overview'))return {
   ok:true,json:async()=>({
    employeeId:'901',role:'owner',authMethod:'totp',
    grantedOperations:['admin.read','tools.settings.read'],
    sectionAccess:{employees:true,settings:true},
    configurationWritesEnabled:false
   })
  };
  if(url.endsWith('/api/settings'))return new Promise(resolve=>{resolveSettings=resolve;});
  throw Error('Unexpected route');
 };
 vm.runInNewContext(client,{document,window,fetch,console},{timeout:1000});
 for(let i=0;i<20&&!resolveSettings;i++)await Promise.resolve();
 assert.equal(typeof resolveSettings,'function');
 document.hidden=true;
 actions.get('hc-admin-suspended')();
 resolveSettings({ok:true,json:async()=>({items:[],readOnly:true})});
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(element('gate').hidden,false);
 assert.equal(element('workspace').hidden,true);
 assert.equal(element('identity').textContent,'');
 assert.equal(element('ownerDelegationPanel').hidden,true);
 assert.equal(element('toolGrantPanel').hidden,true);
 assert.equal(requests,2);
 assert.equal(verified,true,'tab switch preserves the unexpired proof in memory');
});
