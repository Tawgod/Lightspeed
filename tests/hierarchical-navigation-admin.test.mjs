import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 adminDestination,toolGroups,allDestinations,canShowAdminNavigation,refreshAdminNavigation
} from '../shared-ui/operations-nav.mjs';

test('approved hierarchy is Special Orders > preorders > GW, with purchasing nested',()=>{
 const orders=toolGroups.find(g=>g.label==='Special Orders');
 assert.ok(orders);
 const dashboard=orders.items.find(x=>x.id==='special-orders');
 assert.deepEqual(dashboard.children.map(x=>x.id),['preorders','ordering']);
 assert.deepEqual(dashboard.children[0].children.map(x=>x.id),['gw-preorders']);
 assert.deepEqual(toolGroups.map(g=>g.label),['Special Orders','Store Tools']);
 assert.ok(!allDestinations.find(x=>x.id==='employee-admin'),
  'Admin is not an unconditional destination');
});
test('admin link requires independently verified same-origin exact admin.read',async()=>{
 const calls=[];
 const staffAuth={
  readSession:()=>({token:'signed.fixture'}),
  headers:extra=>({...extra,Authorization:'Bearer signed.fixture'})
 };
 const fetchImpl=async (url,init)=>{
  calls.push({url,init});
  return {ok:true,json:async()=>({allowed:true,authenticated:true,operation:'admin.read'})};
 };
 assert.equal(await canShowAdminNavigation(fetchImpl,staffAuth),true);
 assert.equal(calls[0].url,'/api/admin/navigation-access');
 assert.equal(calls[0].init.cache,'no-store');
 assert.equal(calls[0].init.credentials,'omit');
 assert.equal(calls[0].init.headers.Authorization,'Bearer signed.fixture');
 for(const data of [
  {allowed:true,authenticated:false,operation:'admin.read'},
  {allowed:true,authenticated:true,operation:'products.read'},
  {allowed:'true',authenticated:true,operation:'admin.read'},
  {allowed:false,authenticated:true,operation:'admin.read'}
 ])assert.equal(await canShowAdminNavigation(async()=>({ok:true,json:async()=>data}),staffAuth),false);
 assert.equal(await canShowAdminNavigation(async()=>({ok:false}),staffAuth),false);
 assert.equal(await canShowAdminNavigation(async()=>{throw Error('unreachable');},staffAuth),false);
 assert.equal(await canShowAdminNavigation(null,staffAuth),false);
 assert.equal(await canShowAdminNavigation(fetchImpl,{...staffAuth,readSession:()=>null}),false);
 assert.equal(await canShowAdminNavigation(fetchImpl,{...staffAuth,headers:()=>({'x-employee-id':'901'})}),false);
 assert.equal(adminDestination.href,'/employee-admin/');
});
test('admin link appears after permission proof and disappears on revocation',async()=>{
 const previous=globalThis.document;
 const nodes=[];
 const elem=tag=>({
  tag,className:'',dataset:{},textContent:'',children:[],
  append(...children){this.children.push(...children)},
  setAttribute(){},remove(){const i=nodes.indexOf(this);if(i>=0)nodes.splice(i)},
 });
 const nav={
  dataset:{currentTool:'special-orders'},children:[],
  append(node){nodes.push(node)},
  querySelectorAll(selector){return selector==='[data-hc-admin-group]'?nodes.filter(n=>n.dataset.hcAdminGroup):[]}
 };
 const root={hidden:false,createElement:elem,querySelector:()=>nav};
 globalThis.document={createElement:elem};
 const previousWindow=globalThis.window;
 globalThis.window={HCStaffAuth:{readSession:()=>({token:'fixture'}),headers:extra=>({...extra,Authorization:'Bearer fixture'})}};
 try{
  assert.equal(await refreshAdminNavigation(root,async()=>({
   ok:true,json:async()=>({allowed:true,authenticated:true,operation:'admin.read'})
  })),true);
  assert.equal(nodes.length,1);
  assert.equal(nodes[0].children[1].children[0].href,'/employee-admin/');
  assert.equal(await refreshAdminNavigation(root,async()=>({ok:false})),false);
  assert.equal(nodes.length,0);
 }finally{globalThis.document=previous;globalThis.window=previousWindow}
});
test('staff sign-out/in refresh signal exists, no browser role shortcut',()=>{
 const source=readFileSync(new URL('../shared-ui/staff-auth.js',import.meta.url),'utf8');
 const nav=readFileSync(new URL('../shared-ui/operations-nav.mjs',import.meta.url),'utf8');
 assert.match(source,/hc-staff-auth-changed/);
 assert.match(nav,/window\.addEventListener\('hc-staff-auth-changed'/);
 assert.match(nav,/hc-staff-auth-changed/);
 assert.doesNotMatch(nav,/sessionStorage\.(?:getItem|setItem)/);
 assert.doesNotMatch(nav,/\.role\s*===\s*['"]owner['"]/);
});
