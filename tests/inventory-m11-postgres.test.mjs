import test from 'node:test';
import assert from 'node:assert/strict';
import * as security from '../.security-source/tests/fixtures/hc-secure-s25h-contract.mjs';
import {createAuthorizationM8,createLocalTransactionM8} from '../services/lightspeed/authorizationM8.js';
import {prepareExecutionM7} from '../services/lightspeed/localTransactionM7.js';
import {fingerprintLightspeedPayload as hash} from '../services/lightspeed/idempotency.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';

// Isolated evidence records only: no authoritative stock or vendor calls.
// Identifiers deliberately satisfy the pinned Security grammar; no lossy concatenation.
const now=2000000, tenant='shop', effectiveAt='2026-11-24T10:29:00.000Z';
const actor={realm:'employee',id:'e1',tenant,environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null};
const employee={type:'employee',realm:'employee',id:'e1',tenant,delegation:{kind:'none'}};
const live={active:true,revoked:false,startsAt:0,expiresAt:now+100000};
const kinds={
 receipt:['inventory.receipt.confirm','physical-receipt'],
 allocation:['inventory.allocation.create','allocation-intent'],
 release:['inventory.allocation.release','original-allocation'],
 dispatch:['inventory.transfer.dispatch','physical-dispatch'],
 receive:['inventory.transfer.receive','original-dispatch'],
 returned:['inventory.return.confirm','original-physical-fulfillment'],
 adjustment:['inventory.adjustment.execute','verified-discrepancy'],
 count:['inventory.count.observe','count-session'],
 restock:['inventory.restock.confirm','restock-task']
};
const target=(type,id)=>({type:'inventory.'+type,id});
const tk=t=>JSON.stringify([t.type,t.id]);
const row=(e,t)=>e.find(x=>tk(x.target)===tk(t))?.row;
const pg=(name,fn)=>test('M11 '+name,()=>withDisposableCorePg(fn));
const denied=p=>assert.rejects(p,e=>e.code==='CORE_FORBIDDEN'&&e.outcome==='undisclosed');
const conflict=p=>assert.rejects(p,e=>e.code==='CORE_REVISION_CONFLICT');
const effect=(operation,target,location,field)=>({operation,target,location,fields:[field]});
const id=(prefix,line)=>prefix+'-'+line;
const source=(kind,line)=>({
 kind:kinds[kind][1], eventId:id('original',line), businessId:id('business',line),
 lineId:line,productId:line==='L1'?'0001':'0002',variantId:id('variant',line),
 outletId:'01',locationId:'S1',destinationOutletId:['dispatch','receive'].includes(kind)?'02':'01',
 destinationLocationId:['dispatch','receive'].includes(kind)?'S2':'F1',
 quantity:6,effectiveAt,verified:true
});
function specs(kind,line){
 const s=source(kind,line);
 return [
 [target('source',s.eventId),s],
 [target('capacity',id('capacity',line)),{originalEventId:s.eventId,used:0,limit:s.quantity}],
 [target('location',id('from',line)),{outletId:s.outletId,locationId:s.locationId,active:true}],
 [target('location',id('to',line)),{outletId:s.destinationOutletId,locationId:s.destinationLocationId,active:true}],
 [target('product',id('product',line)),{productId:s.productId,variantId:s.variantId}]
 ];
}
async function seed(f,kind,lines=['L1','L2']){
 const records=lines.flatMap(line=>specs(kind,line));
 await f.transaction(async tx=>{for(const [t,record] of records){await tx.lockDomain(t);await tx.insertDomain({...t,record});}},{targets:records.map(x=>x[0])});
}
const inspect=(f,t)=>f.transaction(tx=>tx.lockDomain(t),{targets:[t]});
const capacity=line=>target('capacity',id('capacity',line));
const event=id=>target('physical-event',id);
function request(kind,commandId,quantities=[3,2],revision=1,changes={}){
 const lines=quantities.map((quantity,i)=>{
 const line='L'+(i+1),s=source(kind,line);
 return {...s,originalEventId:s.eventId,eventId:commandId+'-'+line,quantity,...(changes[line]??{})};
 });
 const descriptors=[];
 for(const p of lines){
 const l=p.lineId,s=source(kind,l),op=kinds[kind][0];
 const rs=specs(kind,l);
 const relationships=[{type:'original',id:s.eventId},{type:'business',id:s.businessId},{type:'line',id:l},{type:'product',id:s.productId},{type:'variant',id:s.variantId},{type:'source-outlet',id:s.outletId},{type:'source-location',id:s.locationId},{type:'destination-outlet',id:s.destinationOutletId},{type:'destination-location',id:s.destinationLocationId}];
 for(const [i,[t]] of rs.entries()){
 const r=i===1?revision:1;
 descriptors.push({t,revision:r,effect:effect(op,t,i===3?s.destinationOutletId:s.outletId,'evidence'),relationships,quantity:String(p.quantity)});
 }
 const t=event(p.eventId);
 descriptors.push({t,revision:null,effect:effect(op,t,s.outletId,'evidence'),relationships,quantity:String(p.quantity)});
 }
 const execution=prepareExecutionM7({tenant,scope:'test.inventory.m11',key:'fixture-'+commandId,actor:employee,targets:descriptors.map(d=>d.t),effects:descriptors.map(d=>d.effect),payload:{kind,lines},expectedRevisions:descriptors.map(d=>({target:d.t,revision:d.revision}))});
 const primary=descriptors[0],readEffects=[effect('inventory.evidence.read',primary.t,'01','outcome')],reconcileEffects=[effect('transactions.reconcile',primary.t,'01','receipt')];
 const rich=(e,d)=>({operation:e.operation,tenant,environment:'test',location:e.location,resourceType:e.target.type,resourceId:e.target.id,field:e.fields[0],revision:d.revision===null?'absent':String(d.revision),relationships:d.relationships,quantity:d.quantity,amount:null,currency:null,purpose:'inventory-evidence',audience:null});
 const facts={evidenceRef:'ev1',executionEffects:descriptors.map(d=>rich(d.effect,d)),readEffects:readEffects.map(e=>rich(e,primary)),inspectEffects:reconcileEffects.map(e=>rich(e,primary))};
 const verifyExecution=({command,evidence})=>{
 if(hash(command)!==hash(execution))return false;
 return command.payload.lines.every(p=>{
 const [orig,cap,from,to,prod]=specs(kind,p.lineId).map(([t])=>row(evidence,t)?.record);
 const {eventId,quantity,originalEventId,...identity}=p;
 if(!orig||!cap||!from?.active||!to?.active||!prod||orig.verified!==true||orig.kind!==kinds[kind][1])return false;
 const {eventId:originalId,quantity:limit,...expected}=orig;
 return hash(identity)===hash(expected)&&originalEventId===originalId&&cap.originalEventId===originalId&&cap.limit===limit&&
 from.outletId===orig.outletId&&from.locationId===orig.locationId&&to.outletId===orig.destinationOutletId&&to.locationId===orig.destinationLocationId&&
 prod.productId===orig.productId&&prod.variantId===orig.variantId&&Number.isSafeInteger(quantity)&&quantity>0&&quantity<=cap.limit-cap.used;
 });
 };
 const apply=async(tx,c,e)=>{
 for(const p of c.payload.lines){
 const cap=capacity(p.lineId),old=row(e,cap);
 await tx.insertDomain({...event(p.eventId),record:{...p,stockWrite:false,physicalMovement:!['allocation','release','count','restock'].includes(kind),totalInventoryDelta:kind==='restock'?0:null}});
 await tx.replaceDomain({...cap,expectedRevision:old.revision,record:{...old.record,used:old.record.used+p.quantity}});
 }
 return {id:commandId,outcome:'evidence-recorded'};
 };
 return {execution,approval:{reference:'approval-'+commandId,executionDigest:hash(execution),reviewerId:'e2',expiresAt:live.expiresAt},readEffects,reconcileEffects,verifyExecution,apply,facts};
}
function harness(req,{before,derive,after}={}){
 const facts=()=>structuredClone(req.facts);
 const all=[...req.facts.executionEffects,...req.facts.readEffects,...req.facts.inspectEffects];
 const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
 const registry=[...new Set(all.map(e=>e.operation))].map(operation=>({operation,mode:operation==='inventory.evidence.read'?'read':operation==='transactions.reconcile'?'inspect':'execute',required:['revision','relationships','quantity','purpose'],approvalRequired:!['inventory.evidence.read','transactions.reconcile'].includes(operation),assurance:'business'}));
 const state={evidenceRef:'ev1',policyVersion:'v1',employee:{realm:'employee',id:'e1',tenant,active:true},
 session:{...live,id:'s1',actorId:'e1',tenant,deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false},
 device:{...live,id:'d1',tenant,kind:'personal',actorId:'e1'},
 site:{...live,id:'site1',tenant,deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'},
 policy:{tenant,environment:'test',version:'v1',roles:[{id:'r',active:true,rules:all.map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:live.expiresAt,revoked:false}))}],assignments:[{id:'a',actorId:'e1',roleId:'r',startsAt:0,expiresAt:live.expiresAt,revoked:false}],individual:[]},
 approval:{id:req.approval.reference,scopeDigest:security.executionScopeDigest({actor,executionDigest:hash(req.execution),executionEffects:req.facts.executionEffects}),actorId:'e1',tenant,approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'e2',expiresAt:live.expiresAt},admittedScopes:structuredClone(all)};
 const clock=()=>now,readPolicyVersion=async()=>state.policyVersion;
 const evaluator=security.createOfflineAuthorization({registry,readTrustedState:async()=>state,readPolicyVersion,clock,decisionMaxMs:50});
 const requests=[];
 const authorization=createAuthorizationM8({security,readPolicyVersion,clock,deriveScope:()=>derive?derive(facts()):facts(),decide:async q=>{requests.push(q);if(before)await before(q,state);const r=await evaluator(q);return after?after(q,r):r;}});
 return {authorization,state,requests};
}
const run=(f,h,extra={})=>createLocalTransactionM8({...f,tenant,authorization:h.authorization,receiptSchema:{version:'inventory.m11.receipt',fields:['id','outcome']},projectResult:()=>({}),...extra});
for(const kind of Object.keys(kinds))pg(kind+' exact linked evidence and whole-set replay',async f=>{
 await seed(f,kind);const req=request(kind,'event-A'),h=harness(req),execute=run(f,h);
 assert.deepEqual(await execute(req),{replayed:false,result:{}});
 assert.deepEqual(await execute({...req,apply:()=>assert.fail('reapplied')}),{replayed:true,result:{}});
 assert.equal((await inspect(f,capacity('L1'))).record.used,3);
 assert.equal((await inspect(f,capacity('L2'))).record.used,2);
 const stored=(await inspect(f,event('event-A-L1'))).record;
 assert.equal(stored.originalEventId,'original-L1');assert.equal(stored.productId,'0001');assert.equal(stored.stockWrite,false);
 assert.equal((await inspect(f,target('source','original-L1'))).record.quantity,6);
 assert.ok(h.requests.every(q=>q.executionEffects.length===12));
 assert.equal(new Set(h.requests.map(q=>q.requestId)).size,h.requests.length);
});
pg('competing quantities and fresh reprepare',async f=>{
 await seed(f,'receive');const a=request('receive','event-A',[4,4]),b=request('receive','event-B',[4,4]);
 const r=await Promise.allSettled([run(f,harness(a))(a),run(f,harness(b))(b)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(r.find(x=>x.status==='rejected').reason.code,'CORE_REVISION_CONFLICT');
 const too=request('receive','event-C',[3,3],2);await denied(run(f,harness(too))(too));
 const ok=request('receive','event-D',[2,2],2);await run(f,harness(ok))(ok);
 assert.equal((await inspect(f,capacity('L1'))).record.used,6);
});
pg('partial failure rolls back all lines',async f=>{
 await seed(f,'receipt');const req=request('receipt','event-A');
 await assert.rejects(run(f,harness(req))({...req,apply:async(tx,c,e)=>{await req.apply(tx,c,e);throw Error('synthetic failure')}}),/synthetic failure/);
 assert.equal(await inspect(f,event('event-A-L1')),null);
 assert.equal((await inspect(f,capacity('L1'))).record.used,0);
 assert.equal((await f.counts()).commands,0);
});
pg('duplicate physical event under another command',async f=>{
 await seed(f,'receipt');const a=request('receipt','event-A');await run(f,harness(a))(a);
 const b=request('receipt','event-B',[1,1],2,{L1:{eventId:'event-A-L1'}});
 await conflict(run(f,harness(b))(b));
 assert.equal((await inspect(f,capacity('L1'))).record.used,3);
});
for(const [name,change] of [['financial approval',{kind:'invoice-approved'}],['wrong original',{originalEventId:'wrong'}],['wrong variant',{variantId:'other'}],['wrong location',{destinationLocationId:'wrong'}],['wrong effective time',{effectiveAt:'2026-11-24T10:30:00.000Z'}]])pg(name+' cannot establish physical receipt',async f=>{
 await seed(f,'receipt');const r=request('receipt','event-A',[1,1],1,{L2:change});await denied(run(f,harness(r))(r));assert.equal((await f.counts()).commands,0);
});
for(const [name,options] of [
 ['missing destination grant',{before:(q,s)=>{s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.location!=='02')}}],
 ['mismatched rich scope',{derive:f=>{f.executionEffects[0].quantity='99';return f}}],
 ['changed approval',{before:(q,s)=>{if(q.stage==='precommit')s.approval.id='replacement'}}],
 ['revoked session',{before:(q,s)=>{if(q.stage==='precommit')s.session.revoked=true}}],
 ['malformed decision',{after:()=>({allowed:true})}]
])pg(name+' denies entire transfer',async f=>{
 await seed(f,'receive');const r=request('receive','event-A');await denied(run(f,harness(r,options))(r));assert.equal((await f.counts()).commands,0);assert.equal((await inspect(f,capacity('L1'))).record.used,0);
});
pg('postcommit disclosure denial does not roll back or reapply',async f=>{
 await seed(f,'receipt');const r=request('receipt','event-A'),h=harness(r,{before:(q,s)=>{if(q.stage==='projection')s.policy.roles[0].rules=s.policy.roles[0].rules.filter(x=>x.effect.operation!=='inventory.evidence.read')}});
 await denied(run(f,h)(r));assert.equal((await f.counts()).commands,1);
 assert.equal((await run(f,harness(r))({...r,apply:()=>assert.fail('reapplied')})).replayed,true);
 await denied(run(f,harness(r),{projectResult:()=>({outcome:'evidence-recorded'})})(r));
});
pg('lost acknowledgement requires independent inspection',async f=>{
 await seed(f,'receipt');const r=request('receipt','event-A');
 const transaction=async(...args)=>{await f.transaction(...args);throw Object.assign(Error('lost ack'),{code:'CORE_COMMIT_UNKNOWN'})};
 let calls=0;const h=harness(r,{before:(q,s)=>{if(q.stage==='inspection')s.policy.roles[0].rules=s.policy.roles[0].rules.filter(x=>x.effect.operation!=='transactions.reconcile')}});
 await denied(run(f,h,{transaction,inspectCommitted:async m=>{calls++;return f.inspectCommitted(m)}})(r));assert.equal(calls,0);
 assert.equal((await f.counts()).commands,1);
 assert.equal((await run(f,harness(r))({...r,apply:()=>assert.fail('reapplied')})).replayed,true);
});
pg('unresolved commit remains unknown without resubmission',async f=>{
 await seed(f,'receipt');const r=request('receipt','event-A');let calls=0;
 await assert.rejects(run(f,harness(r),{transaction:async()=>{calls++;throw Object.assign(Error('unknown'),{code:'CORE_COMMIT_UNKNOWN'})},inspectCommitted:async()=>null})(r),e=>e.code==='CORE_COMMIT_UNKNOWN'&&e.outcome==='unknown');
 assert.equal(calls,1);assert.equal((await f.counts()).commands,0);
});
