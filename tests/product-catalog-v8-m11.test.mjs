import test from 'node:test';
import assert from 'node:assert/strict';
import * as security from '../.security-source/tests/fixtures/hc-secure-s25h-contract.mjs';
import {prepareCatalogMutation,inspectCatalogReadback} from '../services/lightspeed/productCatalogMutationCandidate.js';
import {prepareRemoteExecutionM7} from '../services/lightspeed/remoteMutationM7.js';
import {createAuthorizationM8,createRemoteMutationM8} from '../services/lightspeed/authorizationM8.js';
import {fingerprintLightspeedPayload as hash} from '../services/lightspeed/idempotency.js';
import {withRemoteM7Pg} from './fixtures/coreRemoteM7Pg.mjs';
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
 return {execution,approval:{reference:'review-fixture',executionDigest:hash(execution),reviewerId:'employee-reviewer',expiresAt:2100000},
 readEffects:[effect('catalog.product.read',t,'eventId'),effect('catalog.product.read',t,'revision')],
 inspectEffects:[effect('fixture.reconcile',t,'receipt')]};
}
// Exact original decimals stay in the command. Scope uses equivalent canonical
// decimal strings only; unsupported precision is denied by pinned Security.
const now=2000000;
const live={active:true,revoked:false,startsAt:0,expiresAt:now+100000};
const canonicalAmount=v=>v.includes('.')?v.replace(/0+$/,'').replace(/\.$/,''):v;
function richEffect(command,e){
 const amount=['cost','retail','msrp'].includes(e.field)&&Object.hasOwn(command.values,e.field)?canonicalAmount(command.values[e.field]):null;
 return {operation:e.operation,tenant,environment:'test',location:e.location,resourceType:'product',resourceId:command.target.productId,field:e.field,revision:command.predecessor,relationships:[...(command.target.variantId===null?[]:[{type:'variant',id:command.target.variantId}]),...(e.supplierId===null?[]:[{type:'supplier',id:e.supplierId}])],quantity:null,amount,currency:amount===null?null:'USD',purpose:null,audience:null};
}
function harness(req,options={}){
 let time=now,epoch='v1',state,requests=[];
 const map=es=>es.map(e=>richEffect(req.execution,e));
 const facts=()=>({evidenceRef:'ev1',executionEffects:map(req.execution.effects),readEffects:map(req.readEffects),inspectEffects:map(req.reconcileEffects??req.inspectEffects)});
 const all=()=>{const f=facts();return [...f.executionEffects,...f.readEffects,...f.inspectEffects]};
 const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
 const registry=[...new Map(all().map(e=>[e.operation,{operation:e.operation,mode:e.operation==='catalog.product.read'?'read':e.operation==='fixture.reconcile'?'inspect':'execute',required:[],approvalRequired:!['catalog.product.read','fixture.reconcile'].includes(e.operation),assurance:'business'}])).values()];
 const makeState=()=>({evidenceRef:'ev1',policyVersion:epoch,employee:{realm:'employee',id:'employee-a',tenant,active:true},session:{...live,id:'s1',actorId:'employee-a',tenant,deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false},device:{...live,id:'d1',tenant,kind:'personal',actorId:'employee-a'},site:{...live,id:'site1',tenant,deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'},policy:{tenant,environment:'test',version:epoch,roles:[{id:'r',active:true,rules:all().map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:live.expiresAt,revoked:false}))}],assignments:[{id:'a',actorId:'employee-a',roleId:'r',startsAt:0,expiresAt:live.expiresAt,revoked:false}],individual:[]},approval:{id:'review-fixture',scopeDigest:security.executionScopeDigest({actor:{realm:'employee',id:'employee-a',tenant,environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null},executionDigest:hash(req.execution),executionEffects:facts().executionEffects}),actorId:'employee-a',tenant,approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'employee-reviewer',expiresAt:live.expiresAt},admittedScopes:all()});
 state=makeState();
 const clock=()=>time,readPolicyVersion=async()=>epoch;
 const evaluator=security.createOfflineAuthorization({registry,readTrustedState:async()=>state,readPolicyVersion,clock,decisionMaxMs:50});
 const authorization=createAuthorizationM8({security,readPolicyVersion,clock,timeoutMs:options.timeoutMs??1000,deriveScope:({command,digest,reads,inspects})=>{if(hash(command)!==hash(req.execution)||digest!==hash(req.execution)||hash(reads)!==hash(req.readEffects)||hash(inspects)!==hash(req.inspectEffects))throw Error('unadmitted command or access');return facts();},decide:async q=>{requests.push(q);if(options.before)await options.before(q,state);const r=await evaluator(q);return options.after?options.after(q,r,{advance:()=>time++,epoch:()=>{epoch='v2'}}):r;}});
 return {authorization,requests,get state(){return state},expire(){time=2100000;}};
}
function fixture(f,inputs,options={}){
 const sources=new Map(inputs.map(({req,snapshot})=>[req.requestId,{req:structuredClone(req),snapshot:structuredClone(snapshot)}]));
 const admitted=new Map([...sources].map(([k,s])=>[k,derive(s.req,s.snapshot)]));
 const requests=new Map([...admitted].map(([k,d])=>[k,envelope(d)]));
 const hs=new Map([...requests].map(([k,q])=>[k,harness(q,options)]));
 const authorization={bindScope:args=>hs.get(args.command.key).authorization.bindScope(args),authorizeStage:args=>hs.get(args.command.key).authorization.authorizeStage(args)};
 let writes=0,observes=0,lose=false,patch={},events=new Map();
 const engine=createRemoteMutationM8({tenant,store:f.store,authorization,
 deriveFresh:command=>{const s=sources.get(command.key);return derive(s.req,s.snapshot)?.execution??null;},
 dispatch:async({command,digest,eventId})=>{writes++;events.set(eventId,{complete:true,eventId,digest,target:structuredClone(command.target),predecessor:command.predecessor,revision:'result-'+writes,values:structuredClone(command.values)});if(lose)throw Error('lost ack');},
 observe:({command,eventId})=>{observes++;const e=events.get(eventId);if(!e)return null;const d=admitted.get(command.key);
 if(inspectCatalogReadback({proposal:d.proposal,observation:{...e.target,complete:e.complete,fingerprint:d.proposal.fingerprint,version:e.revision,values:e.values}}).state!=='verified_evidence')return null;
 return {...structuredClone(e),...patch};}
 });
 return {engine,env:k=>structuredClone(requests.get(k)),h:k=>hs.get(k),source:k=>sources.get(k),get writes(){return writes},get observes(){return observes},lose:()=>{lose=true},patch:p=>{patch=p}};
}
const pg=(name,fn)=>test(name,()=>withRemoteM7Pg(fn));
const a='request-001',b='request-002';
const create=(t,key,sku,upc)=>({req:request(t,{name:'New',sku,upc},key),snapshot:empty()});
const linked=(t,key,supplierId='S1',supplierSku='0009',sku='0007')=>({req:request(t,{cost:'13.00'},key),snapshot:existing(t,{name:'Old',sku,cost:'12.00',supplierId,supplierSku})});
pg('M11 complete Catalog variant cost effects and replay',async f=>{
 const h=fixture(f,[linked(target('P1','V1'),a)]),q=h.env(a);
 assert.equal(q.execution.values.cost,'13.00');
 assert.equal(q.execution.effects.length,5);
 const r=await h.engine.run(q);assert.equal(r.state,'verified');assert.equal((await h.engine.run(q)).state,'verified');
 assert.equal(h.writes,1);assert.ok(h.h(a).requests.every(q=>q.executionEffects.length===5));
 assert.ok(h.h(a).requests.some(q=>q.stage==='inspection'));assert.ok(h.h(a).requests.some(q=>q.stage==='projection'));
 assert.equal((await f.counts()).reservations,4);
});
pg('M11 missing whole-set cost grant denies without reservation',async f=>{
 const h=fixture(f,[linked(target(),a)]);const s=h.h(a).state;
 s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.operation!=='catalog.product.cost.modify');
 assert.equal((await h.engine.run(h.env(a))).state,'denied');assert.equal(h.writes,0);assert.equal((await f.counts()).commands,0);
});
pg('M11 missing admitted supplier scope denies',async f=>{
 const h=fixture(f,[linked(target('P1','V1'),a)]);h.h(a).state.admittedScopes=h.h(a).state.admittedScopes.filter(e=>!e.relationships.some(r=>r.type==='supplier'));
 assert.equal((await h.engine.run(h.env(a))).state,'denied');assert.equal(h.writes,0);
});
pg('M11 caller altered complete execution denied',async f=>{
 const h=fixture(f,[linked(target(),a)]),q=h.env(a);q.execution.effects.pop();q.approval.executionDigest=hash(q.execution);
 assert.equal((await h.engine.run(q)).state,'denied');assert.equal((await f.counts()).commands,0);
});
for(const variant of [null,'V1'])pg('M11 stale revision '+variant,async f=>{
 const h=fixture(f,[linked(target('P1',variant),a)]);h.source(a).snapshot.version='v2';
 assert.equal((await h.engine.run(h.env(a))).state,'denied');assert.equal(h.writes,0);assert.equal((await f.counts()).reservations,4);
});
pg('M11 revoked dispatch authority retains reservation',async f=>{
 const h=fixture(f,[linked(target(),a)],{before:(q,s)=>{if(q.stage==='dispatch')s.device.revoked=true}});
 assert.equal((await h.engine.run(h.env(a))).state,'denied');assert.equal(h.writes,0);assert.equal((await f.counts()).reservations,4);
});
pg('M11 original approval replacement cannot replay',async f=>{
 const h=fixture(f,[linked(target(),a)]),q=h.env(a);assert.equal((await h.engine.run(q)).state,'verified');
 q.approval.reference='replacement';h.h(a).state.approval.id='replacement';
 assert.notEqual((await h.engine.run(q)).state,'verified');assert.equal(h.writes,1);
});
pg('M11 competing old/new literal identifiers held across unknown and new revision',async f=>{
 const t=target('P1','V1'),s=existing(t,{name:'Old',sku:'0007',upc:'000123'});
 const h=fixture(f,[{req:request(t,{sku:'0008',upc:'000124'},a),snapshot:s},
 {req:request(t,{sku:'0009'},b,'v2'),snapshot:existing(t,{name:'Old',sku:'0008',upc:'000124'},'v2')},
 create(target('P2'),'request-003','0007','000125'),create(target('P3'),'request-004','0010','000124')]);
 h.lose();assert.equal((await h.engine.run(h.env(a))).state,'unknown');
 for(const k of [b,'request-003','request-004'])assert.equal((await h.engine.run(h.env(k))).state,'conflict');
 assert.equal((await h.engine.run(h.env(a))).state,'unknown');assert.equal(h.writes,1);assert.equal((await f.counts()).reservations,6);
});
pg('M11 supplier scoped collision distinct from distinct supplier',async f=>{
 const h=fixture(f,[linked(target(),a),linked(target('P2'),b,'S1','0009','0008'),linked(target('P3'),'request-003','S2','0009','0010')]);
 const r=await Promise.all([h.engine.run(h.env(a)),h.engine.run(h.env(b))]);assert.deepEqual(r.map(x=>x.state).sort(),['conflict','verified']);
 assert.equal((await h.engine.run(h.env('request-003'))).state,'verified');assert.equal(h.writes,2);
});
pg('M11 independent inspection and malformed evidence then denied projection',async f=>{
 const h=fixture(f,[linked(target(),a)]),q=h.env(a);h.lose();assert.equal((await h.engine.run(q)).state,'unknown');
 const s=h.h(a).state,original=s.policy.roles[0].rules;
 s.policy.roles[0].rules=original.filter(r=>r.effect.operation!=='fixture.reconcile');
 assert.equal((await h.engine.reconcile(q)).state,'denied');assert.equal(h.observes,0);s.policy.roles[0].rules=original;
 for(const patch of [{eventId:'wrong'},{predecessor:'wrong'},{values:{cost:'13'}},{complete:false},{target:target('P1','V2')}]){h.patch(patch);assert.equal((await h.engine.reconcile(q)).state,'unknown');}
 const cyclic={};cyclic.self=cyclic;h.patch({values:cyclic});assert.equal((await h.engine.reconcile(q)).state,'unknown');
 h.patch({});s.policy.roles[0].rules=original.filter(r=>r.effect.operation!=='catalog.product.read');
 assert.equal((await h.engine.reconcile(q)).state,'denied');s.policy.roles[0].rules=original;
 assert.equal((await h.engine.run(q)).state,'verified');assert.equal(h.writes,1);h.h(a).expire();assert.equal((await h.engine.run(q)).state,'denied');
});
test('M11 no supplier reassignment, PO cost or implicit variant create',()=>{
 assert.equal(derive(request(target(),{name:'New',sku:'0007',supplierId:'S1',supplierSku:'0009'}),empty()),null);
 assert.equal(derive(request(target('P1','V1'),{name:'New',sku:'0007'}),empty()),null);
 assert.equal(derive(request(target(),{poCost:'13.00'}),empty()),null);
});
