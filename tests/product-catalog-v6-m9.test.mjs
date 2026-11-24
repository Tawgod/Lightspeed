import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCatalogMutation,inspectCatalogReadback} from '../services/lightspeed/productCatalogMutationCandidate.js';
import {fingerprintLightspeedPayload as hash} from '../services/lightspeed/idempotency.js';

// Domain contract model only: one JS event loop, no durable store, remote client or runtime authorization.
const target={productId:'P1',variantId:null};
const ev={source:'fixture',provenance:'row'};
const refs=()=>Object.fromEntries(['suppliers','brands','manufacturers','departments','categories','tags'].map(k=>[k,[]]));
const snap=()=>({version:'v1',complete:true,identityComplete:true,referencesComplete:true,linksComplete:true,links:[],references:refs(),products:[],identity:[]});
const clone=structuredClone;
const key=(...v)=>JSON.stringify(v);
function model(initial=snap()){
 let snapshot=clone(initial),seq=0;
 const reservations=new Map(),commands=new Map(),events=new Map();
 const result=(state)=>({state,retryAllowed:false});
 const scope=(operation,t,field,supplierId=null)=>({operation,tenant:'fixture',environment:'test',productId:t.productId,variantId:t.variantId,field,supplierId});
 function prepare(request,actor='employee-a'){
  const proposal=prepareCatalogMutation({request,snapshot});
  if(proposal.state!=='review_required')return null;
  const p=proposal.plan,t=p.target,prior=snapshot.products.find(x=>x.productId===t.productId&&x.variantId===t.variantId);
  const effective={...prior?.values,...p.after};
  const supplier=effective.supplierId??null;
  const effects=Object.keys(p.after).sort().flatMap(field=>[
   scope('catalog.product.'+p.effect,t,field),
   ...(field==='cost'?[scope('catalog.product.cost.modify',t,field,supplier)]:[])
  ]);
  effects.push(scope('catalog.product.'+p.effect+'.execute',t,null));
  effects.push(scope('catalog.product.'+p.effect+'.approve',t,null));
  const identityKeys=[key('target',t.productId,t.variantId)];
  for(const field of ['sku','upc','supplierSku'])if(effective[field]!==undefined)
   identityKeys.push(key(field,field==='supplierSku'?supplier:null,effective[field]));
  const facts={actor,tenant:'fixture',environment:'test',proposal,effects,identityKeys:identityKeys.sort(),supplier};
  return clone({...facts,digest:hash(facts),request});
 }
 const permit=async (allow,effects,stage,actor)=>{
  try{for(const effect of effects)if(await allow(clone(effect),stage,actor)!==true)return false;return true;}catch{return false;}
 };
 const binding=c=>{const {digest,request,...facts}=c;return hash(facts)===digest;};
 async function execute(c,{allow=()=>true,approval=c.digest,beforeDispatch=()=>{},lose=false}={}){
  c=clone(c);
  if(!binding(c)||approval!==c.digest||!await permit(allow,c.effects,'execution',c.actor))return result('denied');
  const k=c.request.requestId,old=commands.get(k);
  if(old)return result(old.digest!==c.digest?'conflict':old.state);
  // Synchronous all-or-nothing fixture reservation; Core owns future atomic durable implementation.
  if(c.identityKeys.some(x=>reservations.has(x)))return result('reserved');
  for(const x of c.identityKeys)reservations.set(x,k);
  const row={digest:c.digest,state:'reserved',command:c};commands.set(k,row);
  await beforeDispatch();
  if(!await permit(allow,c.effects,'dispatch',c.actor)){row.state='denied';return result('denied');}
  const fresh=prepare(c.request,c.actor);
  if(!fresh||fresh.digest!==c.digest){row.state='stale';return result('stale');}
  const p=c.proposal.plan;
  const event={id:'event-'+(++seq),digest:c.digest,previousVersion:p.version,version:'revision-'+seq,target:clone(p.target),values:clone(p.after)};
  events.set(event.id,clone(event));row.eventId=event.id;
  snapshot.version=event.version;
  const prior=snapshot.products.find(x=>x.productId===p.target.productId&&x.variantId===p.target.variantId);
  if(prior)Object.assign(prior.values,p.after);
  else snapshot.products.push({...p.target,active:true,values:clone(p.after)});
  row.state=lose?'unknown':'dispatched';
  return result(row.state);
 }
 function evidence(row,observation){
  const c=row.command,e=events.get(row.eventId);
  return Boolean(e&&observation&&observation.eventId===e.id&&observation.digest===c.digest&&
   observation.previousVersion===e.previousVersion&&observation.version===e.version&&
   inspectCatalogReadback({proposal:c.proposal,observation}).state==='verified_evidence');
 }
 async function inspect(c,observation,allow=()=>true){
  const row=commands.get(c.request.requestId);
  if(!row||!binding(c)||row.digest!==c.digest||!await permit(allow,c.effects,'execution',c.actor)||
   !await permit(allow,[scope('fixture.reconcile',c.proposal.plan.target,null)],'inspection',c.actor))return result('denied');
  if(!evidence(row,observation))return result('unknown');
  row.state='verified';return result('verified');
 }
 async function project(c,allow=()=>true){
  const row=commands.get(c.request.requestId);
  if(!row||!binding(c)||row.digest!==c.digest||!await permit(allow,c.effects,'execution',c.actor)||
   !await permit(allow,[scope('catalog.product.read',c.proposal.plan.target,'receipt')],'projection',c.actor))return result('denied');
  return result(row.state);
 }
 function observation(c){
  const row=commands.get(c.request.requestId),e=events.get(row?.eventId);
  return e?{...e.target,complete:true,eventId:e.id,digest:e.digest,previousVersion:e.previousVersion,version:e.version,values:clone(e.values),fingerprint:c.proposal.fingerprint}:null;
 }
 return {prepare,execute,inspect,project,observation,get writes(){return seq;},changeRevision:()=>{snapshot.version='external-revision';}};
}
const req=(id='request-1',sku='0007',t=target,desired={name:'New',sku,cost:'12.00'})=>({requestId:id,target:t,desired,expectedVersion:'v1'});
test('M9 concurrent distinct keys and intended IDs with same SKU reserve only once',async()=>{
 const m=model(),a=m.prepare(req()),b=m.prepare(req('request-2','0007',{productId:'P2',variantId:null}));
 const results=await Promise.all([m.execute(a),m.execute(b)]);
 assert.deepEqual(results.map(x=>x.state).sort(),['dispatched','reserved']);assert.equal(m.writes,1);
});
test('M9 distinct keys for same target cannot bypass reservation',async()=>{
 const m=model(),a=m.prepare(req()),b=m.prepare(req('request-2','0008'));
 await m.execute(a);assert.equal((await m.execute(b)).state,'reserved');assert.equal(m.writes,1);
});
test('M9 lost acknowledgement retains cross-key reservation and blocks replay',async()=>{
 const m=model(),a=m.prepare(req()),b=m.prepare(req('request-2'));
 assert.equal((await m.execute(a,{lose:true})).state,'unknown');
 assert.equal((await m.execute(b)).state,'reserved');assert.equal((await m.execute(a)).state,'unknown');assert.equal(m.writes,1);
});
test('M9 fresh revision checked after reservation before dispatch',async()=>{
 const m=model(),a=m.prepare(req());assert.equal((await m.execute(a,{beforeDispatch:m.changeRevision})).state,'stale');assert.equal(m.writes,0);
});
test('M9 exact cost field and target independently authorized across tools',async()=>{
 for(const tool of ['scanner','purchasing','product-manager','special-orders','import']){
  const m=model(),a=m.prepare(req());
  const allow=e=>e.operation!=='catalog.product.cost.modify';
  assert.equal((await m.execute(a,{allow})).state,'denied',tool);assert.equal(m.writes,0);
 }
});
test('M9 altered actor or variant cannot reuse command digest',async()=>{
 const m=model(),a=m.prepare(req());
 assert.equal((await m.execute({...a,actor:'employee-b'})).state,'denied');
 const b=clone(a);b.effects[0].variantId='V1';assert.equal((await m.execute(b)).state,'denied');assert.equal(m.writes,0);
});
test('M9 existing variant cost requires exact variant scoped grant',async()=>{
 const s=snap(),t={productId:'P1',variantId:'V1'};
 s.products=[{...t,active:true,values:{sku:'0007',name:'Old',cost:'10.00'}}];
 s.identity=[{...t,active:true,identifiers:[{kind:'SKU',exactValue:'0007',...ev}]}];
 const m=model(s),a=m.prepare(req('request-1','0007',t,{cost:'12.00'}));
 assert.ok(a);assert.equal((await m.execute(a,{allow:e=>e.variantId===null})).state,'denied');assert.equal(m.writes,0);
});
test('M9 supplier relationship change remains gated',()=>{
 const s=snap();s.references.suppliers=[{id:'S1',name:'Supplier',...ev}];
 const m=model(s);assert.equal(m.prepare(req('request-1','0007',target,{name:'New',sku:'0007',supplierId:'S1',supplierSku:'0001'})),null);
});
test('M9 independent inspection and projection authority do not change approval digest',async()=>{
 const m=model(),a=m.prepare(req());await m.execute(a,{lose:true});const obs=m.observation(a);
 assert.equal((await m.inspect(a,obs,e=>e.operation!=='fixture.reconcile')).state,'denied');
 assert.equal((await m.inspect(a,obs)).state,'verified');
 assert.equal((await m.project(a,e=>e.operation!=='catalog.product.read')).state,'denied');
 assert.deepEqual(await m.project(a),{state:'verified',retryAllowed:false});assert.equal(m.writes,1);
});
test('M9 matching values alone or wrong event/predecessor cannot prove causal readback',async()=>{
 const m=model(),a=m.prepare(req());await m.execute(a,{lose:true});const obs=m.observation(a);
 for(const patch of [{eventId:'other'},{previousVersion:'other'},{digest:'other'},{version:'other'},{values:{...obs.values,cost:'12'}}])
  assert.equal((await m.inspect(a,{...obs,...patch})).state,'unknown');
 assert.equal((await m.inspect(a,obs)).state,'verified');assert.equal(m.writes,1);
});
test('M9 revocation before dispatch denies and projection denial never rolls back',async()=>{
 const m=model(),a=m.prepare(req());assert.equal((await m.execute(a,{allow:(e,stage)=>stage!=='dispatch'})).state,'denied');assert.equal(m.writes,0);
 const n=model(),b=n.prepare(req());await n.execute(b);assert.equal((await n.project(b,()=>false)).state,'denied');assert.equal(n.writes,1);
});
