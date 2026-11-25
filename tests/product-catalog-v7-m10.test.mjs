import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCatalogMutation,inspectCatalogReadback} from '../services/lightspeed/productCatalogMutationCandidate.js';
import {prepareRemoteExecutionM7,createRemoteMutationM7} from '../services/lightspeed/remoteMutationM7.js';
import {fingerprintLightspeedPayload as hash} from '../services/lightspeed/idempotency.js';
import {withRemoteM7Pg} from './fixtures/coreRemoteM7Pg.mjs';

// Only domain evidence derivation and a synthetic event producer here.
// All reservation, dispatch lifecycle, audit, replay and reconciliation use Core.
const tenant='catalog-fixture',actor={id:'employee-a',realm:'employee',tenant};
const target=(productId='P1',variantId=null)=>({productId,variantId});
const ev={source:'fixture',provenance:'normalized-row'};
const same=(a,b)=>a.productId===b.productId&&a.variantId===b.variantId;
const refs=()=>Object.fromEntries(['suppliers','brands','manufacturers','departments','categories','tags'].map(k=>[k,[]]));
const empty=()=>({complete:true,version:'v1',products:[],identity:[],links:[],references:refs(),identityComplete:true,linksComplete:true,referencesComplete:true});
const time='2026-11-25T00:00:00.000Z';
function existing(t,values,version='v1'){
 const s=empty();s.version=version;
 s.products.push({...t,active:true,values:{...values}});
 const identifiers=[{kind:'SKU',exactValue:values.sku,...ev}];
 if(values.upc!==undefined)identifiers.push({kind:'UPC',exactValue:values.upc,...ev});
 if(values.supplierId!==undefined){
  s.references.suppliers.push({id:values.supplierId,name:'Synthetic supplier',...ev});
  s.links.push({...t,supplierId:values.supplierId,supplierSku:values.supplierSku,primary:true,observedAt:time,...ev});
  identifiers.push({kind:'SUPPLIER_SKU',exactValue:values.supplierSku,supplierId:values.supplierId,...ev});
 }
 s.identity.push({...t,active:true,identifiers});return s;
}
const request=(t,desired,key='request-001',expectedVersion='v1')=>({target:t,desired,requestId:key,expectedVersion});
const effect=(operation,t,field,supplierId=null)=>({operation,target:t,location:'store-fixture',field,supplierId});
function derive(req,snapshot){
 const proposal=prepareCatalogMutation({request:req,snapshot});
 if(proposal.state!=='review_required')return null;
 const p=proposal.plan,t=p.target;
 const prior=snapshot.products.find(x=>same(x,t));
 // No unreviewed supplier create, variant create or alias mapping.
 const before=prior?.values??{},after={...before,...p.after};
 const keys=[['target',t.productId,t.variantId]];
 if(prior)keys.push(['revision',t.productId,t.variantId,p.version]);
 for(const v of [before,after]){
  if(v.sku!==undefined)keys.push(['sku',v.sku]);
  if(v.upc!==undefined)keys.push(['upc',v.upc]);
  if(v.supplierSku!==undefined){
   if(typeof v.supplierId!=='string')return null;
   keys.push(['supplierSku',v.supplierId,v.supplierSku]);
  }
 }
 const reservationKeys=[...new Map(keys.map(k=>[JSON.stringify(k),k])).values()];
 const base='catalog.product.'+p.effect;
 const effects=Object.keys(p.after).flatMap(field=>[
  effect(base,t,field),effect(base+'.approve',t,field),effect(base+'.execute',t,field),
  ...(field==='cost'?[effect('catalog.product.cost.modify',t,field),
   ...(after.supplierId?[effect('catalog.product.cost.modify',t,field,after.supplierId)]:[])]:[])
 ]);
 // This fixture models a master cost patch with a verified existing supplier context.
 // Two independently scoped cost decisions are conservative; no second price write implied.
 const execution=prepareRemoteExecutionM7({tenant,key:p.requestId,actor,target:t,predecessor:prior?p.version:null,values:p.after,effects,reservationKeys});
 return {execution,proposal,snapshotVersion:p.version,request:structuredClone(req)};
}
function envelope(d){
 const execution=d.execution,t=execution.target;
 return {execution,approval:{reference:'review-fixture',executionDigest:hash(execution),reviewerId:'employee-reviewer',expiresAt:2000},
 readEffects:[effect('catalog.product.read',t,'eventId'),effect('catalog.product.read',t,'revision')],
 inspectEffects:[effect('fixture.reconcile',t,'receipt')]};
}
function fixture(f,inputs){
 const sources=new Map(inputs.map(({req,snapshot})=>[req.requestId,{req:structuredClone(req),snapshot:structuredClone(snapshot)}]));
 const initial=new Map([...sources].map(([k,s])=>[k,derive(s.req,s.snapshot)]));
 const events=new Map();let writes=0,observes=0,clock=1000,lose=false,patch={},allow=()=>true,access=()=>true,changeAtStage=null;
 const engine=createRemoteMutationM7({tenant,store:f.store,
 authorizeExecution:({effect:e,stage,command})=>{
  if(changeAtStage?.stage===stage){changeAtStage.fn(sources.get(command.key));changeAtStage=null;}
  return allow(e,stage,command);
 },
 verifyApproval:({proof})=>proof.expiresAt>clock&&proof.reviewerId==='employee-reviewer',
 authorizeAccess:({effect:e,kind,stage})=>access(e,kind,stage),
 deriveFresh:command=>{
  const source=sources.get(command.key),original=initial.get(command.key);
  if(source.snapshot.version!==original.snapshotVersion)return null;
  const d=derive(source.req,source.snapshot);
  return d?.execution??null;
 },
 dispatch:async({command,digest,eventId})=>{
  // Model the vendor event independently from the observation callback.
  const revision='revision-'+(++writes);
  events.set(eventId,{complete:true,eventId,digest,target:structuredClone(command.target),
   predecessor:command.predecessor,revision,values:structuredClone(command.values)});
  if(lose)throw Error('synthetic acknowledgement lost');
 },
 observe:({command,eventId})=>{
  observes++;const e=events.get(eventId);if(!e)return null;
  const d=initial.get(command.key);
  const o={...e.target,complete:e.complete,fingerprint:d.proposal.fingerprint,version:e.revision,values:e.values};
  if(inspectCatalogReadback({proposal:d.proposal,observation:o}).state!=='verified_evidence')return null;
  return {...structuredClone(e),...patch};
 }
 });
 return {engine,env:key=>envelope(initial.get(key)),source:key=>sources.get(key),
  get writes(){return writes;},get observes(){return observes;},
  lose:()=>{lose=true;},patch:p=>{patch=p;},allow:fn=>{allow=fn;},access:fn=>{access=fn;},
  expire:()=>{clock=2000;},changeAt:(stage,fn)=>{changeAtStage={stage,fn};}};
}
const pg=(name,fn)=>test(name,()=>withRemoteM7Pg(fn));
const a='request-001',b='request-002';
const create=(t,key,sku,upc)=>({req:request(t,{name:'New',sku,upc},key),snapshot:empty()});
const linked=(t,key,supplierId,supplierSku,sku)=>({req:request(t,{cost:'13.00'},key),
 snapshot:existing(t,{name:'Old',sku,cost:'12.00',supplierId,supplierSku})});
for(const kind of ['sku','upc'])pg('M10 shared ledger competing '+kind+' across distinct intended products',async f=>{
 const h=fixture(f,[create(target(),a,'0007','000123'),create(target('P2'),b,kind==='sku'?'0007':'0008',kind==='upc'?'000123':'000124')]);
 const r=await Promise.all([h.engine.run(h.env(a)),h.engine.run(h.env(b))]);
 assert.deepEqual(r.map(x=>x.state).sort(),['conflict','verified']);
 assert.equal(h.writes,1);assert.equal((await f.counts()).reservations,3);assert.equal((await f.counts()).commands,1);
});
pg('M10 conflicting individually normalized supplier views reserve scoped SKU atomically',async f=>{
 // Independent complete synthetic views intentionally disagree globally; this is a reservation guard,
 // not evidence that two already-colliding catalog records are valid.
 const h=fixture(f,[linked(target(),a,'S1','0009','0007'),linked(target('P2'),b,'S1','0009','0008')]);
 const r=await Promise.all([h.engine.run(h.env(a)),h.engine.run(h.env(b))]);
 assert.deepEqual(r.map(x=>x.state).sort(),['conflict','verified']);assert.equal(h.writes,1);
 assert.equal((await f.counts()).reservations,4);assert.equal((await f.counts()).commands,1);
});
pg('M10 same supplier code at different canonical suppliers is not equivalent',async f=>{
 const h=fixture(f,[linked(target(),a,'S1','0009','0007'),linked(target('P2'),b,'S2','0009','0008')]);
 const r=await Promise.all([h.engine.run(h.env(a)),h.engine.run(h.env(b))]);
 assert.deepEqual(r.map(x=>x.state),['verified','verified']);assert.equal(h.writes,2);
});
pg('M10 supplier-linked variant cost requires base update, approval, execution and both cost scopes',async f=>{
 const t=target('P1','V1'),h=fixture(f,[linked(t,a,'S1','0009','0007')]);
 for(const predicate of [e=>e.operation==='catalog.product.update',e=>e.operation==='catalog.product.update.approve',
 e=>e.operation==='catalog.product.update.execute',e=>e.operation==='catalog.product.cost.modify'&&e.supplierId===null,
 e=>e.operation==='catalog.product.cost.modify'&&e.supplierId==='S1']){
  h.allow(e=>!predicate(e));assert.equal((await h.engine.run(h.env(a))).state,'denied');
 }
 assert.equal((await f.counts()).commands,0);assert.equal(h.writes,0);
 h.allow(e=>same(e.target,t));const r=await h.engine.run(h.env(a));
 assert.equal(r.state,'verified');assert.deepEqual(Object.keys(r.result).sort(),['eventId','revision']);assert.equal(h.writes,1);
});
for(const variantId of [null,'V1'])pg('M10 stale '+(variantId?'variant':'product')+' revision blocked at dispatch',async f=>{
 const t=target('P1',variantId),h=fixture(f,[linked(t,a,'S1','0009','0007')]);
 h.changeAt('dispatch',s=>{s.snapshot.version='v2';});
 assert.equal((await h.engine.run(h.env(a))).state,'denied');assert.equal(h.writes,0);
 assert.equal((await f.counts()).reservations,4);
});
pg('M10 old and new identifier guards survive unknown outcome and new revision',async f=>{
 const t=target('P1','V1'),s=existing(t,{name:'Old',sku:'0007',upc:'000123'});
 const update={req:request(t,{sku:'0008',upc:'000124'},a),snapshot:s};
 const competing={req:request(t,{sku:'0009'},b,'v2'),snapshot:existing(t,{name:'Old',sku:'0008',upc:'000124'},'v2')};
 const old=create(target('P2'),'request-003','0007','000125');
 const next=create(target('P3'),'request-004','0010','000124');
 const h=fixture(f,[update,competing,old,next]);h.lose();
 assert.equal((await h.engine.run(h.env(a))).state,'unknown');
 for(const k of [b,'request-003','request-004'])assert.equal((await h.engine.run(h.env(k))).state,'conflict');
 assert.equal(h.writes,1);assert.equal((await f.counts()).reservations,6);
});
pg('M10 causal reconciliation and independent receipt projection never redispatch',async f=>{
 const h=fixture(f,[linked(target(),a,'S1','0009','0007')]);h.lose();const q=h.env(a);
 assert.equal((await h.engine.run(q)).state,'unknown');
 h.access((e,kind)=>kind!=='inspect');assert.equal((await h.engine.reconcile(q)).state,'denied');assert.equal(h.observes,0);
 h.access(()=>true);
 for(const patch of [{eventId:'wrong'},{digest:'wrong'},{predecessor:'wrong'},{values:{cost:'13'}},{complete:false},{target:target('P1','V2')}]){
  h.patch(patch);assert.equal((await h.engine.reconcile(q)).state,'unknown');
 }
 h.patch({});h.access((e,kind)=>kind!=='read');assert.equal((await h.engine.reconcile(q)).state,'denied');
 h.access(()=>true);const r=await h.engine.run({...q,readEffects:[q.readEffects[1]]});
 assert.equal(r.state,'verified');assert.deepEqual(Object.keys(r.result),['revision']);assert.equal(h.writes,1);
 h.expire();assert.equal((await h.engine.run(q)).state,'denied');assert.equal(h.writes,1);
});
test('M10 literal keys, inactive collision and supplier mapping gates preserve M7 domain preparation',()=>{
 const t=target(),d=derive(request(t,{name:'New',sku:'0007-A',upc:'000123'}),empty());
 assert.ok(d.execution.reservationKeys.some(k=>JSON.stringify(k)===JSON.stringify(['sku','0007-A'])));
 assert.equal(derive(request(t,{name:'New',sku:' 0007'}),empty()),null);
 const s=existing(target('P2'),{name:'Old',sku:'0007'});s.identity[0].active=false;s.products[0].active=false;
 assert.equal(derive(request(t,{name:'New',sku:'0007'}),s),null);
 assert.equal(derive(request(target('P1','V1'),{name:'New',sku:'0008'}),empty()),null);
 assert.equal(derive(request(t,{name:'New',sku:'0008',supplierId:'S1',supplierSku:'0009'}),empty()),null);
});
