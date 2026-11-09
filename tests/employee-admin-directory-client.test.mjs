import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../admin/employee-admin-client.js',import.meta.url),'utf8');

async function boot({directoryAllowed}={}){
 const nodes=new Map(),handlers=new Map(),requested=[];
 const mk=()=>({hidden:true,textContent:'',className:'',children:[],
  addEventListener(){},replaceChildren(){this.children=[]},
  append(...nodes){this.children.push(...nodes)}
 });
 const get=id=>{if(!nodes.has(id))nodes.set(id,mk());return nodes.get(id)};
 const document={
  hidden:false,getElementById:get,createElement:()=>mk()
 };
 const window={
  HCAdminAuth:{getProof:()=>({baseToken:'bound.test',factorToken:'signed.mfa',factorType:'totp'})},
  addEventListener(name,fn){handlers.set(name,fn)},
  confirm:()=>true
 };
 const fetch=async(url,options)=>{
  requested.push({url,options});
  let body;
  if(url.endsWith('/overview'))body={
   employeeId:'901',role:'owner',authMethod:'totp',configurationWritesEnabled:false,
   grantedOperations:['admin.read','tools.settings.read',...(directoryAllowed?['employees.directory.read']:[])],
   sectionAccess:{employees:true,settings:true}
  };
  else if(url.endsWith('/settings'))body={items:[],readOnly:true};
  else if(url.endsWith('/employees'))body={
   source:'timeclock',readOnly:true,scope:'directory',employees:[
    {id:'901',name:'Synthetic Owner',active:true,email:'do-not-show@example.test',pin_hash:'do-not-show'}
   ]
  };
  else throw Error('Unexpected route '+url);
  return {ok:true,json:async()=>body};
 };
 for(const name of ['delegationForm','settingScopeForm','toolGrantForm','reload']){
  get(name).addEventListener=(event,callback)=>handlers.set(name+':'+event,callback);
 }
 vm.runInNewContext(source,{document,window,fetch,console},{timeout:1000});
 for(let i=0;i<30;i++)await Promise.resolve();
 return {get,handlers,requested};
}
test('staging-style admin without directory grant never requests employee records',async()=>{
 const h=await boot({directoryAllowed:false});
 assert.equal(h.requested.some(req=>req.url.endsWith('/employees')),false);
 assert.equal(h.get('employeeDirectoryPanel').hidden,true);
});
test('permitted directory renders only minimum employee identity and keeps credentials out',async()=>{
 const h=await boot({directoryAllowed:true});
 assert.equal(h.requested.filter(req=>req.url.endsWith('/employees')).length,1);
 assert.equal(h.get('employeeDirectoryPanel').hidden,false);
 assert.equal(h.get('employeeDirectoryList').children.length,1);
 const row=h.get('employeeDirectoryList').children[0];
 const details=row.children[0];
 assert.equal(details.children[0].textContent,'Synthetic Owner');
 assert.equal(details.children[1].textContent,'Timeclock employee 901');
 assert.equal(row.children[1].textContent,'Active');
 const rendered=JSON.stringify(h.get('employeeDirectoryList'));
 assert.doesNotMatch(rendered,/do-not-show|pin_hash|example.test/);
 assert.match(h.get('employeeDirectoryStatus').textContent,/1 employee record/);
});
