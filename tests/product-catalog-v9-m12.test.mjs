import test from 'node:test';
import assert from 'node:assert/strict';
import * as security from '../.security-source/tests/fixtures/hc-secure-s25h-contract.mjs';
import {deriveCatalogIntentM12,createCatalogDomainAdapterM12} from '../services/lightspeed/productCatalogAdapterM12.js';
import {fingerprintLightspeedPayload as hash} from '../services/lightspeed/idempotency.js';
import {withRemoteM7Pg} from './fixtures/coreRemoteM7Pg.mjs';
const now=2000000;
const live={active:true,revoked:false,startsAt:0,expiresAt:now+100000};
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
function harness(req,facts,options={}){
 let time=now,epoch='v1',state,requests=[];
 const all=()=>{const f=facts;return [...f.executionEffects,...f.readEffects,...f.inspectEffects]};
 const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
 const registry=[...new Map(all().map(e=>[e.operation,{operation:e.operation,mode:e.operation==='catalog.product.read'?'read':e.operation==='fixture.reconcile'?'inspect':'execute',required:[],approvalRequired:!['catalog.product.read','fixture.reconcile'].includes(e.operation),assurance:'business'}])).values()];
 const makeState=()=>({evidenceRef:'ev1',policyVersion:epoch,employee:{realm:'employee',id:'employee-a',tenant,active:true},session:{...live,id:'s1',actorId:'employee-a',tenant,deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false},device:{...live,id:'d1',tenant,kind:'personal',actorId:'employee-a'},site:{...live,id:'site1',tenant,deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'},policy:{tenant,environment:'test',version:epoch,roles:[{id:'r',active:true,rules:all().map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:live.expiresAt,revoked:false}))}],assignments:[{id:'a',actorId:'employee-a',roleId:'r',startsAt:0,expiresAt:live.expiresAt,revoked:false}],individual:[]},approval:{id:'review-fixture',scopeDigest:security.executionScopeDigest({actor:{realm:'employee',id:'employee-a',tenant,environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null},executionDigest:hash(req.execution),executionEffects:facts.executionEffects}),actorId:'employee-a',tenant,approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'employee-reviewer',expiresAt:live.expiresAt},admittedScopes:all()});
 state=makeState();
 const clock=()=>time,readPolicyVersion=async()=>epoch;
 const evaluator=security.createOfflineAuthorization({registry,readTrustedState:async()=>state,readPolicyVersion,clock,decisionMaxMs:50});
 const decide=async q=>{requests.push(q);if(options.before)await options.before(q,state);return evaluator(q)};
 return {decide,clock,readPolicyVersion,requests,get state(){return state},expire(){time=2100000;}};
}
const evidence=(snapshot,currency='USD')=>({tenant,environment:'test',location:'store-fixture',currency,evidenceRef:'ev1',snapshot});
const a='request-001',b='request-002';
const linked=(t,key,supplierId='S1',supplierSku='0009',sku='0007')=>({req:request(t,{cost:'13.00'},key),snapshot:existing(t,{name:'Old',sku,cost:'12.00',supplierId,supplierSku})});
const create=(t,key,sku,upc)=>({req:request(t,{name:'New',sku,upc},key),snapshot:empty()});
function fixture(f,inputs,options={}){
 const originals=new Map(),fresh=new Map(),hs=new Map(),events=new Map();
 let writes=0,observes=0,lose=false,patch={},clockTime=now;
 const clock=()=>clockTime;
 for(const {req,snapshot} of inputs){
  const e=evidence(snapshot),d=deriveCatalogIntentM12({tenant,actor,request:req,evidence:e});
  const approval={reference:'review-fixture',executionDigest:hash(d.execution),reviewerId:'employee-reviewer',expiresAt:2100000};
  originals.set(req.requestId,{request:structuredClone(req),evidence:structuredClone(e),approval,actor:structuredClone(actor)});
  fresh.set(req.requestId,structuredClone(e));
  hs.set(req.requestId,harness({...d,approval},d.facts,options));
 }
 // Independent Security state selected by exact execution digest; no policy engine here.
 const byDigest=new Map([...originals].map(([k,r])=>[r.approval.executionDigest,hs.get(k)]));
 const engine=createCatalogDomainAdapterM12({tenant,resolveActor:ctx=>ctx===context?actor:null,readOriginal:({key})=>originals.get(key),readFresh:({key})=>fresh.get(key),clock,
 authorizationOptions:{security,clock,readPolicyVersion:async()=> 'v1',decide:q=>byDigest.get(q.executionDigest)?.decide(q)},store:f.store,
 dispatch:async({command,digest,eventId})=>{writes++;events.set(eventId,{complete:true,eventId,digest,target:structuredClone(command.target),predecessor:command.predecessor,revision:'result-'+writes,values:structuredClone(command.values)});if(lose)throw Error('lost ack')},
 observe:({eventId})=>{observes++;const e=events.get(eventId);return e?{...structuredClone(e),...patch}:null}
 });
 return {engine,env:key=>({context,request:{requestId:key}}),h:key=>hs.get(key),original:key=>originals.get(key),fresh:key=>fresh.get(key),get writes(){return writes},get observes(){return observes},lose:()=>{lose=true},patch:p=>{patch=p},expire:()=>{clockTime=2100000}};
}
const context=Object.freeze({});
const pg=(name,fn)=>test(name,()=>withRemoteM7Pg(fn));
pg('M12 reusable variant cost adapter preserves exact amount and whole set',async f=>{
 const h=fixture(f,[linked(target('P1','V1'),a)]),q=h.env(a);
 assert.equal((await h.engine.run(q)).state,'verified');assert.equal((await h.engine.run(q)).state,'verified');assert.equal(h.writes,1);
 const rs=h.h(a).requests;assert.ok(rs.every(q=>q.executionEffects.length===5));
 assert.ok(rs.some(q=>q.stage==='inspection'));assert.ok(rs.some(q=>q.stage==='projection'));
 assert.ok(rs[0].executionEffects.every(e=>e.amount==='13'&&e.currency==='USD'));
 assert.equal((await f.counts()).reservations,4);
});
pg('M12 rejects untrusted actor and caller supplied prepared evidence',async f=>{
 const h=fixture(f,[linked(target(),a)]),q=h.env(a);
 assert.equal((await h.engine.run({...q,context:{}})).state,'undisclosed');
 assert.equal((await h.engine.run({...q,request:{requestId:a,actor,approval:h.original(a).approval}})).state,'undisclosed');
 assert.equal(h.writes,0);assert.equal((await f.counts()).commands,0);
});
pg('M12 whole set grant denial and incomplete supplier admission',async f=>{
 const h=fixture(f,[linked(target(),a)]),s=h.h(a).state,original=s.policy.roles[0].rules;
 s.policy.roles[0].rules=original.filter(r=>r.effect.operation!=='catalog.product.cost.modify');
 assert.equal((await h.engine.run(h.env(a))).state,'undisclosed');s.policy.roles[0].rules=original;
 s.admittedScopes=s.admittedScopes.filter(e=>!e.relationships.some(r=>r.type==='supplier'));
 assert.equal((await h.engine.run(h.env(a))).state,'undisclosed');assert.equal(h.writes,0);assert.equal((await f.counts()).commands,0);
});
for(const variant of [null,'V1'])pg('M12 stale original revision '+variant,async f=>{
 const h=fixture(f,[linked(target('P1',variant),a)]);h.fresh(a).snapshot.version='v2';
 assert.equal((await h.engine.run(h.env(a))).state,'undisclosed');assert.equal(h.writes,0);
});
pg('M12 changed fresh currency and immutable original intent',async f=>{
 const h=fixture(f,[linked(target(),a)]);h.fresh(a).currency='EUR';
 assert.equal((await h.engine.run(h.env(a))).state,'undisclosed');assert.equal(h.writes,0);
 h.original(a).request.desired.cost='14.00';assert.equal((await h.engine.run(h.env(a))).state,'undisclosed');assert.equal(h.writes,0);
});
pg('M12 revoked authority at dispatch retains reservation',async f=>{
 const h=fixture(f,[linked(target(),a)],{before:(q,s)=>{if(q.stage==='dispatch')s.device.revoked=true}});
 assert.equal((await h.engine.run(h.env(a))).state,'undisclosed');assert.equal(h.writes,0);assert.equal((await f.counts()).reservations,4);
});
pg('M12 original approval replacement cannot replay',async f=>{
 const h=fixture(f,[linked(target(),a)]),q=h.env(a);assert.equal((await h.engine.run(q)).state,'verified');
 h.original(a).approval.reference='replacement';h.h(a).state.approval.id='replacement';
 assert.notEqual((await h.engine.run(q)).state,'verified');assert.equal(h.writes,1);
});
pg('M12 old and new typed identities remain held after unknown',async f=>{
 const t=target('P1','V1'),s=existing(t,{name:'Old',sku:'0007',upc:'000123'});
 const h=fixture(f,[{req:request(t,{sku:'0008',upc:'000124'},a),snapshot:s},
 {req:request(t,{sku:'0009'},b,'v2'),snapshot:existing(t,{name:'Old',sku:'0008',upc:'000124'},'v2')},
 create(target('P2'),'request-003','0007','000125'),create(target('P3'),'request-004','0010','000124')]);
 h.lose();assert.equal((await h.engine.run(h.env(a))).state,'unknown');
 for(const k of [b,'request-003','request-004'])assert.equal((await h.engine.run(h.env(k))).state,'conflict');
 assert.equal((await h.engine.run(h.env(a))).state,'unknown');assert.equal(h.writes,1);assert.equal((await f.counts()).reservations,6);
});
pg('M12 supplier scoped collision and distinct supplier',async f=>{
 const h=fixture(f,[linked(target(),a),linked(target('P2'),b,'S1','0009','0008'),linked(target('P3'),'request-003','S2','0009','0010')]);
 const r=await Promise.all([h.engine.run(h.env(a)),h.engine.run(h.env(b))]);assert.deepEqual(r.map(x=>x.state).sort(),['conflict','verified']);
 assert.equal((await h.engine.run(h.env('request-003'))).state,'verified');assert.equal(h.writes,2);
});
pg('M12 independent access, malformed observation, unknown and replay',async f=>{
 const h=fixture(f,[linked(target(),a)]),q=h.env(a);h.lose();assert.equal((await h.engine.run(q)).state,'unknown');
 const s=h.h(a).state,original=s.policy.roles[0].rules;
 s.policy.roles[0].rules=original.filter(r=>r.effect.operation!=='fixture.reconcile');
 assert.equal((await h.engine.reconcile(q)).state,'undisclosed');assert.equal(h.observes,0);s.policy.roles[0].rules=original;
 for(const patch of [{eventId:'wrong'},{predecessor:'wrong'},{values:{cost:'13'}},{complete:false},{target:target('P1','V2')}]){h.patch(patch);assert.equal((await h.engine.reconcile(q)).state,'unknown');}
 h.patch({});s.policy.roles[0].rules=original.filter(r=>r.effect.operation!=='catalog.product.read');
 assert.equal((await h.engine.reconcile(q)).state,'undisclosed');s.policy.roles[0].rules=original;
 // Reconcile/replay use original intent, not a changed vendor revision.
 h.fresh(a).snapshot.version='v2';assert.equal((await h.engine.run(q)).state,'verified');assert.equal(h.writes,1);
 h.expire();assert.equal((await h.engine.run(q)).state,'undisclosed');
});
test('M12 exact monetary evidence, cost boundaries and supplier gates',()=>{
 const {req,snapshot}=linked(target('P1','V1'),a),e=evidence(snapshot,'CAD');
 const d=deriveCatalogIntentM12({tenant,actor,request:req,evidence:e});
 assert.equal(d.execution.values.cost,'13.00');assert.equal(d.facts.executionEffects[0].currency,'CAD');
 assert.ok(d.execution.reservationKeys.some(k=>JSON.stringify(k)===JSON.stringify(['supplierSku','S1','0009'])));
 for(const desired of [{cost:'13.1234567'},{supplierId:'S2'},{supplierSku:'0010'},{poCost:'13.00'}])assert.throws(()=>deriveCatalogIntentM12({tenant,actor,request:{...req,desired},evidence:e}));
 assert.throws(()=>deriveCatalogIntentM12({tenant,actor,request:req,evidence:{...e,currency:null}}));
 assert.throws(()=>deriveCatalogIntentM12({tenant,actor,request:req,evidence:{...e,tenant:'other'}}));
});
