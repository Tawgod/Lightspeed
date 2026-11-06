import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('admin screen is inert without trusted factor provider and does not expose raw credentials',async()=>{
 const code=await readFile(new URL('../admin/employee-admin-client.js',import.meta.url),'utf8');
 const page=await readFile(new URL('../admin/employee-admin.html',import.meta.url),'utf8');
 assert.match(page,/Administrator verification required/);
 assert.match(page,/Development.*Not released/);
 assert.doesNotMatch(page,/type="password"/);
 let network=0;
 const callbacks=new Map();
 const elements=new Map();
 const el=id=>{
  if(!elements.has(id))elements.set(id,{
   textContent:'',hidden:false,replaceChildren(){},
   addEventListener(name,fn){callbacks.set(id+name,fn)},
   append(){},className:''
  });
  return elements.get(id);
 };
 const context={
  window:{},
  document:{getElementById:el,createElement:tag=>({
   tagName:tag,textContent:'',append(){},className:''
  })},
  fetch:async()=>{network++;throw Error('Unexpected call')},
  console
 };
 vm.runInNewContext(code,context,{timeout:1000});
 assert.equal(network,0);
 assert.equal(typeof callbacks.get('reloadclick'),'function');
 await callbacks.get('reloadclick')();
 assert.equal(network,0);
 assert.equal(el('gate').hidden,false);
 assert.equal(el('workspace').hidden,true);
});
