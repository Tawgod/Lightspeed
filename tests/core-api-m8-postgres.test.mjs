import test from 'node:test';
import assert from 'node:assert/strict';
import * as security from '../.security-source/tests/fixtures/hc-secure-s25h-contract.mjs';
import {createAuthorizationM8,createLocalTransactionM8,createRemoteMutationM8} from '../services/lightspeed/authorizationM8.js';
import {prepareExecutionM7} from '../services/lightspeed/localTransactionM7.js';
import {prepareRemoteExecutionM7} from '../services/lightspeed/remoteMutationM7.js';
import {fingerprintLightspeedPayload as hash} from '../services/lightspeed/idempotency.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
import {withRemoteM7Pg} from './fixtures/coreRemoteM7Pg.mjs';
const now=2000000,tenant='fixture',target={type:'product',id:'p1'},rt={productId:'p1',variantId:null};
const live={active:true,revoked:false,startsAt:0,expiresAt:now+100000};
const actor={realm:'employee',id:'e1',tenant,environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null};
const le=(operation,fields)=>({operation,target,location:'store',fields});
const re=(operation,field)=>({operation,target:rt,location:'store',field,supplierId:null});
const exec=prepareExecutionM7({tenant,scope:'test.catalog',key:'fixture-001',actor:{type:'employee',realm:'employee',id:'e1',tenant,delegation:{kind:'none'}},targets:[target],effects:[le('fixture.write',['cost']),le('fixture.cost',['cost'])],payload:{cost:'12'},expectedRevisions:[{target,revision:null}]});
const remote=prepareRemoteExecutionM7({tenant,key:'fixture-001',actor:{id:'e1',realm:'employee',tenant},target:rt,predecessor:null,values:{cost:'12'},effects:[re('fixture.write','cost'),re('fixture.cost','cost')],reservationKeys:[['target','p1',null]]});
const approval=c=>({reference:'ap1',executionDigest:hash(c),reviewerId:'e2',expiresAt:now+100000});
const localRequest={execution:exec,approval:approval(exec),readEffects:[le('fixture.read',['id'])],reconcileEffects:[le('fixture.inspect',['receipt'])],verifyExecution:()=>true,apply:async tx=>({id:'p1',revision:await tx.insertDomain({...target,record:{cost:'12'}})})};
const remoteRequest={execution:remote,approval:approval(remote),readEffects:[re('fixture.read','eventId')],inspectEffects:[re('fixture.inspect','receipt')]};
function harness(req,options={}){
 let time=now,epoch='v1',state,requests=[],amount='12';
 const map=(es)=>es.flatMap(e=>(e.fields??[e.field]).map(field=>({operation:e.operation,tenant,environment:'test',location:e.location,resourceType:'product',resourceId:e.target.id??e.target.productId,field,revision:null,relationships:[],quantity:null,amount:e.operation==='fixture.cost'?amount:null,currency:e.operation==='fixture.cost'?'USD':null,purpose:null,audience:null})));
 const facts=()=>({evidenceRef:'ev1',executionEffects:map(req.execution.effects),readEffects:map(req.readEffects),inspectEffects:map(req.reconcileEffects??req.inspectEffects)});
 const all=()=>{const f=facts();return [...f.executionEffects,...f.readEffects,...f.inspectEffects]};
 const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
 const registry=['fixture.write','fixture.cost','fixture.read','fixture.inspect'].map((operation,i)=>({operation,mode:i<2?'execute':i===2?'read':'inspect',required:[],approvalRequired:i<2,assurance:'business'}));
 const makeState=()=>({evidenceRef:'ev1',policyVersion:epoch,employee:{realm:'employee',id:'e1',tenant,active:true},session:{...live,id:'s1',actorId:'e1',tenant,deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false},device:{...live,id:'d1',tenant,kind:'personal',actorId:'e1'},site:{...live,id:'site1',tenant,deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'},policy:{tenant,environment:'test',version:epoch,roles:[{id:'r',active:true,rules:all().map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:live.expiresAt,revoked:false}))}],assignments:[{id:'a',actorId:'e1',roleId:'r',startsAt:0,expiresAt:live.expiresAt,revoked:false}],individual:[]},approval:{id:'ap1',scopeDigest:security.executionScopeDigest({actor,executionDigest:hash(req.execution),executionEffects:facts().executionEffects}),actorId:'e1',tenant,approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'e2',expiresAt:live.expiresAt},admittedScopes:all()});
 state=makeState();
 const clock=()=>time,readPolicyVersion=async()=>epoch;
 const evaluator=security.createOfflineAuthorization({registry,readTrustedState:async()=>state,readPolicyVersion,clock,decisionMaxMs:50});
 const authorization=createAuthorizationM8({security,readPolicyVersion,clock,timeoutMs:options.timeoutMs??1000,deriveScope:facts,decide:async q=>{requests.push(q);if(options.before)await options.before(q,state);const r=await evaluator(q);return options.after?options.after(q,r,{advance:()=>time++,epoch:()=>{epoch='v2'}}):r;}});
 return {authorization,requests,get state(){return state},changeScope(){amount='13';state=makeState();}};
}
const local=(f,h,extra={})=>createLocalTransactionM8({...f,tenant,authorization:h.authorization,receiptSchema:{version:'receipt.v1',fields:['id','revision']},projectResult:r=>({id:r.id}),...extra});
const denied=p=>assert.rejects(p,e=>e.code==='CORE_FORBIDDEN'&&e.outcome==='undisclosed');
test('M8 local complete sets, unique fresh decisions, durable replay',()=>withDisposableCorePg(async f=>{
 const h=harness(localRequest),run=local(f,h);
 assert.deepEqual(await run(localRequest),{replayed:false,result:{id:'p1'}});
 assert.equal((await run({...localRequest,apply:()=>assert.fail('reapplied')})).replayed,true);
 assert.ok(h.requests.every(q=>q.executionEffects.length===2));
 assert.equal(new Set(h.requests.map(q=>q.requestId)).size,h.requests.length);
 assert.ok(h.requests.some(q=>q.stage==='precommit'));assert.ok(h.requests.some(q=>q.stage==='projection'));
 assert.equal((await f.counts()).commands,1);
 h.changeScope();await assert.rejects(run(localRequest));assert.equal((await f.counts()).commands,1);
}));
for(const [name,options] of [
 ['missing grant',{before:(q,s)=>{s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.operation!=='fixture.cost')}}],
 ['revoked session',{before:(q,s)=>{if(q.stage==='precommit')s.session.revoked=true}}],
 ['expired approval',{before:(q,s)=>{s.approval.expiresAt=now}}],
 ['malformed response',{after:()=>({allowed:true})}],
 ['clock advanced',{after:(q,r,c)=>{c.advance();return r}}],
 ['stale policy',{after:(q,r,c)=>{c.epoch();return r}}],
 ['timeout',{timeoutMs:20,before:()=>new Promise(()=>{})}],
 ['unavailable',{before:()=>{throw Error('offline')}}]
])test('M8 local denies '+name,()=>withDisposableCorePg(async f=>{
 const h=harness(localRequest,options);await denied(local(f,h)(localRequest));assert.equal((await f.counts()).commands,0);
}));
test('M8 local projection denied after durable commit',()=>withDisposableCorePg(async f=>{
 const h=harness(localRequest,{before:(q,s)=>{if(q.stage==='projection')s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.operation!=='fixture.read')}});
 await denied(local(f,h)(localRequest));assert.equal((await f.counts()).commands,1);
}));
function remoteEngine(f,h,extra={}){
 let writes=0,event;
 const engine=createRemoteMutationM8({tenant,store:f.store,authorization:h.authorization,deriveFresh:c=>c,dispatch:async({command,digest,eventId})=>{writes++;event={complete:true,eventId,digest,target:command.target,predecessor:command.predecessor,revision:'v2',values:command.values}},observe:()=>event,...extra});
 return {engine,get writes(){return writes}};
}
test('M8 remote fresh complete sets, verified replay and changed scope conflict',()=>withRemoteM7Pg(async f=>{
 const h=harness(remoteRequest),r=remoteEngine(f,h);
 assert.equal((await r.engine.run(remoteRequest)).state,'verified');
 assert.equal((await r.engine.run(remoteRequest)).state,'verified');assert.equal(r.writes,1);
 h.changeScope();assert.notEqual((await r.engine.run(remoteRequest)).state,'verified');assert.equal(r.writes,1);
 assert.ok(h.requests.every(q=>q.executionEffects.length===2));assert.ok(h.requests.some(q=>q.stage==='inspection'));
}));
test('M8 remote revoked dispatch retains hold',()=>withRemoteM7Pg(async f=>{
 const h=harness(remoteRequest,{before:(q,s)=>{if(q.stage==='dispatch')s.device.revoked=true}}),r=remoteEngine(f,h);
 assert.equal((await r.engine.run(remoteRequest)).state,'denied');assert.equal(r.writes,0);assert.equal((await f.counts()).commands,1);
}));
test('M8 remote denied inspection cannot observe or disclose',()=>withRemoteM7Pg(async f=>{
 const h=harness(remoteRequest,{before:(q,s)=>{if(q.stage==='inspection')s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.operation!=='fixture.inspect')}}),r=remoteEngine(f,h,{observe:()=>assert.fail('observed')});
 assert.equal((await r.engine.run(remoteRequest)).state,'denied');assert.equal(r.writes,1);
 assert.equal((await r.engine.reconcile(remoteRequest)).state,'denied');assert.equal(r.writes,1);
}));
