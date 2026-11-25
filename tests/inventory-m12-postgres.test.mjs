import test from 'node:test';
import assert from 'node:assert/strict';
import * as security from '../.security-source/tests/fixtures/hc-secure-s25h-contract.mjs';
import {createInventoryAdapterM12,prepareInventoryM12,inventoryTargetM12 as T} from '../services/lightspeed/inventoryAdapterM12.js';
import {fingerprintLightspeedPayload as hash} from '../services/lightspeed/idempotency.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
const tenant='shop',actor={type:'employee',realm:'employee',id:'e1',tenant,delegation:{kind:'none'}},sa={realm:'employee',id:'e1',tenant,environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null};
const now=2000000, at='2026-11-25T10:00:00.000Z',later='2026-11-25T10:01:00.000Z',live={active:true,revoked:false,startsAt:0,expiresAt:now+100000};
const rec=(target,record,revision=1)=>({target,record,revision});
const inspect=(f,t)=>f.transaction(tx=>tx.lockDomain(t),{targets:[t]});
const seed=async(f,rs)=>f.transaction(async tx=>{for(const r of rs){await tx.lockDomain(r.target);await tx.insertDomain({...r.target,record:r.record});}},{targets:rs.map(r=>r.target)});
const snapshot=async(f,ts)=>{const a=[];for(const target of ts){const r=await inspect(f,target);if(r)a.push({target,...r});}return a;};
const pg=(n,fn)=>test('M12 '+n,()=>withDisposableCorePg(fn));
const input=(key,kind,data,recordedAt=later)=>({key,kind,data,recordedAt});
const p=(id,over={})=>({sourceSystem:'fixture',sourceAccount:'store',sourceId:'source-'+id,lineId:'L1',productId:'0001',variantId:'v1',outletId:'01',locationId:'S1',destinationOutletId:'02',destinationLocationId:'S2',effectiveAt:at,unit:'each',eventId:id,originalEventId:null,quantity:'4.5',...over});
const loc=(outletId,locationId,kind='storage')=>({outletId,locationId,kind,active:true,shelfCode:locationId,area:kind,labelDescription:locationId});
const product=rec(T('product','0001','v1'),{productId:'0001',variantId:'v1',verified:true});
const locations=[rec(T('location','01','S1'),loc('01','S1')),rec(T('location','02','S2'),loc('02','S2')),rec(T('location','01','F1'),loc('01','F1','floor'))];
const source=(x,kind)=>rec(T('source',x.sourceSystem,x.sourceAccount,x.sourceId,x.lineId),{...x,kind,verified:true});
const physical=(key,kind,lines)=>input(key,kind,{lines});
function harness(f,intent,records,options={}){
 const plan=prepareInventoryM12({tenant,actor,intent,records}),ap={reference:'ap-'+intent.key,executionDigest:hash(plan.execution),reviewerId:'e2',expiresAt:live.expiresAt};
 const all=[...plan.facts.executionEffects,...plan.facts.readEffects,...plan.facts.inspectEffects];
 const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
 const registry=[...new Set(all.map(e=>e.operation))].map(operation=>({operation,mode:operation==='inventory.evidence.read'?'read':operation==='transactions.reconcile'?'inspect':'execute',required:['revision','relationships','purpose'],approvalRequired:!['inventory.evidence.read','transactions.reconcile'].includes(operation),assurance:'business'}));
 const state={evidenceRef:'ev1',policyVersion:'v1',employee:{realm:'employee',id:'e1',tenant,active:true},session:{...live,id:'s1',actorId:'e1',tenant,deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false},device:{...live,id:'d1',tenant,kind:'personal',actorId:'e1'},site:{...live,id:'site1',tenant,deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'},policy:{tenant,environment:'test',version:'v1',roles:[{id:'r',active:true,rules:all.map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:live.expiresAt,revoked:false}))}],assignments:[{id:'a',actorId:'e1',roleId:'r',startsAt:0,expiresAt:live.expiresAt,revoked:false}],individual:[]},approval:{id:ap.reference,scopeDigest:security.executionScopeDigest({actor:sa,executionDigest:hash(plan.execution),executionEffects:plan.facts.executionEffects}),actorId:'e1',tenant,approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'e2',expiresAt:live.expiresAt},admittedScopes:structuredClone(all)};
 const clock=()=>now,readPolicyVersion=async()=>state.policyVersion,requests=[];
 const evaluator=security.createOfflineAuthorization({registry,readTrustedState:async()=>state,readPolicyVersion,clock,decisionMaxMs:50});
 const adapter=createInventoryAdapterM12({...f,tenant,resolveActor:ctx=>ctx==='authenticated'?actor:null,loadOriginal:({key})=>key===intent.key?{intent,records,actorId:options.originalActor??actor.id,tenant,approvalRef:ap.reference}:null,loadApproval:()=>options.replacement?{...ap,reference:'replacement'}:ap,resolveEvidenceRef:()=>state.evidenceRef,authorizationOptions:{security,clock,readPolicyVersion,decide:async q=>{requests.push(q);await options.before?.(q,state);return evaluator(q);}},...options.adapters});
 return {plan,state,requests,run:(request={key:intent.key},context='authenticated')=>adapter.run({context,request})};
}
const verified={state:'verified',retryAllowed:false,replayed:false,result:{}};
const undisclosed={state:'undisclosed',retryAllowed:false},unknown={state:'unknown',retryAllowed:false},conflict={state:'revision_conflict',retryAllowed:false};
const reason={code:'missing',label:'Missing',revision:1,active:true,requiresNote:false,reviewFlag:'possible_shortage',appliesTo:['zero','partial']};
const reasonRow=rec(T('reason','missing'),reason);
const taskLine={lineId:'L1',outletId:'01',productId:'0001',variantId:'v1',fromLocationId:'S1',toLocationId:'F1',plannedQuantity:4};
const scan={outletId:'01',productId:'0001',variantId:'v1',scanId:'scan1',countMode:'shelf',locationId:'F1',countedQuantity:'3.5',scannedAt:at};
pg('dispatch and receive link actual committed original and fractional capacity',async f=>{
 const x=p('dispatch1'),y=p('receive1',{originalEventId:x.eventId,quantity:'2.25',effectiveAt:later}),s=[product,...locations,source(x,'verified-dispatch'),source(y,'verified-receive')];await seed(f,s);
 const h=harness(f,physical('dispatch-key','dispatch',[x]),s);assert.deepEqual(await h.run(),verified);
 assert.ok(h.requests.every(q=>q.executionEffects.length===h.plan.facts.executionEffects.length));
 const rows=await snapshot(f,[...s.map(r=>r.target),T('event',x.eventId),T('capacity',x.eventId)]);
 const r=harness(f,physical('receive-key','receive',[y]),rows);assert.deepEqual(await r.run(),verified);
 assert.equal((await inspect(f,T('capacity',x.eventId))).record.used,'2.25');
 assert.equal((await inspect(f,T('event',y.eventId))).record.originalEventId,x.eventId);
 assert.deepEqual(await r.run(),{...verified,replayed:true});
});
for(const [kind,originalKind,sourceKind,originalSource] of [['release','allocation','verified-release','verified-allocation-intent'],['returned','fulfillment','verified-returned','verified-handoff']])pg(kind+' consumes actual immutable original',async f=>{
 const x=p('orig',{destinationOutletId:'01',destinationLocationId:'F1'}),y=p('next',{destinationOutletId:'01',destinationLocationId:'F1',originalEventId:'orig',quantity:'1.25'}),s=[product,...locations,source(x,originalSource),source(y,sourceKind)];await seed(f,s);
 assert.deepEqual(await harness(f,physical('original-key',originalKind,[x]),s).run(),verified);
 const rows=await snapshot(f,[...s.map(r=>r.target),T('event','orig'),T('capacity','orig')]);
 assert.deepEqual(await harness(f,physical('reversal-key',kind,[y]),rows).run(),verified);
 assert.equal((await inspect(f,T('capacity','orig'))).record.used,'1.25');
});
pg('competing reversal quantity and stale original snapshot',async f=>{
 const x=p('orig'),y=p('a',{originalEventId:'orig',quantity:'3'}),z=p('b',{originalEventId:'orig',quantity:'3'}),s=[product,...locations,source(x,'verified-dispatch'),source(y,'verified-receive'),source(z,'verified-receive')];await seed(f,s);
 await harness(f,physical('original-key','dispatch',[x]),s).run();
 const rows=await snapshot(f,[...s.map(r=>r.target),T('event','orig'),T('capacity','orig')]);
 const a=harness(f,physical('receive-a','receive',[y]),rows),b=harness(f,physical('receive-b','receive',[z]),rows);
 const results=await Promise.all([a.run(),b.run()]);assert.equal(results.filter(r=>r.state==='verified').length,1);assert.equal(results.filter(r=>r.state==='revision_conflict').length,1);
 const next=await snapshot(f,[...s.map(r=>r.target),T('event','orig'),T('capacity','orig')]);
 assert.throws(()=>harness(f,physical('receive-c','receive',[p('c',{...z,eventId:'c'})]),next));
 assert.equal((await inspect(f,T('capacity','orig'))).record.used,'3');
});
pg('source uniqueness across commands and multi-line atomic rollback',async f=>{
 const x=p('a',{destinationOutletId:'01',destinationLocationId:'F1'}),y=p('b',{destinationOutletId:'01',destinationLocationId:'F1'}),s=[product,...locations,source(x,'verified-receipt'),source(y,'verified-receipt')];await seed(f,s);
 const h=harness(f,physical('receipt-key','receipt',[x,y]),s,{before:(q,state)=>{if(q.stage==='precommit')state.session.revoked=true}});
 assert.deepEqual(await h.run(),undisclosed);assert.equal(await inspect(f,T('event','a')),null);assert.equal(await inspect(f,T('event','b')),null);assert.equal((await f.counts()).commands,0);
 assert.deepEqual(await harness(f,physical('receipt-key','receipt',[x,y]),s).run(),verified);
 const z={...x,eventId:'duplicate'},r=harness(f,physical('duplicate-key','receipt',[z]),s);assert.deepEqual(await r.run(),conflict);
});
test('M12 rejects financial evidence, wrong unit, wrong variant, wrong time, duplicate source and missing locations',()=>{
 const x=p('a'),i=physical('dispatch-key','dispatch',[x]),s=[product,...locations,source(x,'verified-dispatch')],prepare=rs=>prepareInventoryM12({tenant,actor,intent:i,records:rs});
 for(const bad of ['invoice-approved','payment','refund','sale','credit','fulfillment-observation'])assert.throws(()=>prepare([product,...locations,source(x,bad)]));
 for(const change of [{unit:'case'},{variantId:'v2'},{effectiveAt:later}])assert.throws(()=>prepare([product,...locations,source({...x,...change},'verified-dispatch')]));
 assert.throws(()=>prepare([product,locations[0],source(x,'verified-dispatch')]));
 assert.throws(()=>prepareInventoryM12({tenant,actor,intent:physical('duplicate-key','dispatch',[x,{...x,eventId:'b'}]),records:s}));
});
pg('count session observation close discrepancy review resolution',async f=>{
 await seed(f,[product,...locations,reasonRow]);
 const session=T('session','C1'),st=()=>snapshot(f,[session,product.target,locations[2].target,T('scan','C1','scan1'),reasonRow.target,T('review','R1')]);
 const run=async i=>harness(f,i,await st()).run();
 assert.deepEqual(await run(input('count-create','count.create',{id:'C1',outletId:'01'},at)),verified);
 assert.deepEqual(await run(input('count-scan','count.observe',{id:'C1',outletId:'01',request:scan})),verified);
 assert.equal((await inspect(f,T('scan','C1','scan1'))).record.scannedAt,at);
 assert.deepEqual(await run(input('count-close','count.close',{id:'C1',outletId:'01'})),verified);
 await assert.rejects(run(input('count-late','count.observe',{id:'C1',outletId:'01',request:{...scan,scanId:'scan2'}})));
 assert.deepEqual(await run(input('count-review','count.review',{id:'C1',outletId:'01',scanId:'scan1',reviewId:'R1',reasonCode:'missing'})),verified);
 assert.deepEqual(await run(input('review-resolve','review.resolve',{id:'R1',outletId:'01',resolution:'investigate'})),verified);
 assert.equal((await inspect(f,T('review','R1'))).record.state,'resolved');
 assert.equal((await inspect(f,T('review','R1'))).record.quantityVariance,null);
});
pg('reason revision and restock task confirmation retain old reason and zero stock delta',async f=>{
 await seed(f,[product,...locations]);
 const ts=[product.target,...locations.map(x=>x.target),T('reason','missing'),T('task','T1')];
 const run=async i=>harness(f,i,await snapshot(f,ts)).run();
 assert.deepEqual(await run(input('reason-create','reason.revise',{id:'missing',outletId:'01',next:reason})),verified);
 assert.deepEqual(await run(input('task-create','restock.create',{id:'T1',outletId:'01',lines:[taskLine]})),verified);
 const request={taskVersion:'v1',batchId:'B1',lines:[{...taskLine,movedQuantity:0,reasonCode:'missing',confirmedAt:at}]};
 assert.deepEqual(await run(input('task-confirm','restock.confirm',{id:'T1',outletId:'01',request})),verified);
 assert.deepEqual(await run(input('reason-revise','reason.revise',{id:'missing',outletId:'01',next:{...reason,revision:2,active:false}})),verified);
 const batch=(await inspect(f,T('batch','B1'))).record;
 assert.equal(batch.totalInventoryDelta,0);assert.equal(batch.lines[0].reason.revision,1);
 assert.equal((await inspect(f,T('reason-revision','missing',1))).record.active,true);
 assert.equal((await inspect(f,T('task','T1'))).record.state,'closed');
 assert.equal((await inspect(f,T('review',JSON.stringify(['T1','L1'])))).record.state,'open');
});
for(const [kind,id] of [['count','C1'],['restock','T1']])pg(kind+' cancel is revision-bound and terminal',async f=>{
 await seed(f,[product,...locations]);
 const t=T(kind==='count'?'session':'task',id),ts=[t,product.target,...locations.map(x=>x.target)];
 const create=input('create-key',kind+'.create',{id,outletId:'01',...(kind==='restock'?{lines:[taskLine]}:{})},at);
 assert.deepEqual(await harness(f,create,await snapshot(f,ts)).run(),verified);
 const cancel=input('cancel-key',kind+'.cancel',{id,outletId:'01'});
 assert.deepEqual(await harness(f,cancel,await snapshot(f,ts)).run(),verified);
 assert.equal((await inspect(f,t)).record.state,'cancelled');
 assert.throws(()=>prepareInventoryM12({tenant,actor,intent:cancel,records:[rec(t,{...(kind==='count'?{sessionId:id}:{taskId:id}),outletId:'01',state:'cancelled',openedAt:at},2)]}));
});
pg('trusted key-only admission, original actor and approval binding',async f=>{
 const x=p('a'),s=[product,...locations,source(x,'verified-dispatch')];await seed(f,s);
 const i=physical('dispatch-key','dispatch',[x]),h=harness(f,i,s);
 assert.deepEqual(await h.run({key:i.key,actor:'e1'}),undisclosed);
 assert.deepEqual(await h.run({key:i.key},'browser'),undisclosed);
 assert.deepEqual(await harness(f,i,s,{originalActor:'other'}).run(),undisclosed);
 assert.deepEqual(await harness(f,i,s,{replacement:true}).run(),undisclosed);
 assert.equal((await f.counts()).commands,0);
 assert.deepEqual(await h.run(),verified);
 assert.deepEqual(await harness(f,i,s,{replacement:true}).run(),undisclosed);
});
pg('missing destination grant and rich admission deny entire transfer',async f=>{
 const x=p('a'),s=[product,...locations,source(x,'verified-dispatch')];await seed(f,s);const i=physical('dispatch-key','dispatch',[x]);
 const h=harness(f,i,s);h.state.policy.roles[0].rules=h.state.policy.roles[0].rules.filter(r=>r.effect.location!=='02');assert.deepEqual(await h.run(),undisclosed);
 const r=harness(f,i,s);r.state.admittedScopes[0].quantity='9';assert.deepEqual(await r.run(),undisclosed);
 assert.equal((await f.counts()).commands,0);
});
pg('postcommit denied disclosure, replay and independent inspection',async f=>{
 const x=p('a'),s=[product,...locations,source(x,'verified-dispatch')];await seed(f,s);const i=physical('dispatch-key','dispatch',[x]);
 const h=harness(f,i,s,{before:(q,state)=>{if(q.stage==='projection')state.policy.roles[0].rules=state.policy.roles[0].rules.filter(r=>r.effect.operation!=='inventory.evidence.read')}});
 assert.deepEqual(await h.run(),undisclosed);assert.equal((await f.counts()).commands,1);
 assert.deepEqual(await harness(f,i,s).run(),{...verified,replayed:true});
});
pg('lost acknowledgement authorized inspection and denied inspection never retry',async f=>{
 const x=p('a'),s=[product,...locations,source(x,'verified-dispatch')];await seed(f,s);const i=physical('dispatch-key','dispatch',[x]);let calls=0;
 const transaction=async(...args)=>{await f.transaction(...args);throw Object.assign(Error('lost acknowledgement'),{code:'CORE_COMMIT_UNKNOWN'});};
 const h=harness(f,i,s,{adapters:{transaction,inspectCommitted:async m=>{calls++;return f.inspectCommitted(m)}}});
 assert.deepEqual(await h.run(),{...verified,replayed:true});assert.equal(calls,1);
 const r=harness(f,i,s,{adapters:{transaction,inspectCommitted:()=>assert.fail('unauthorized inspection')},before:(q,state)=>{if(q.stage==='inspection')state.policy.roles[0].rules=state.policy.roles[0].rules.filter(r=>r.effect.operation!=='transactions.reconcile')}});
 assert.deepEqual(await r.run(),undisclosed);assert.equal((await f.counts()).commands,1);
});
pg('unknown outcome stays unknown and no automatic retry',async f=>{
 const x=p('a'),s=[product,...locations,source(x,'verified-dispatch')];await seed(f,s);let calls=0;
 const h=harness(f,physical('dispatch-key','dispatch',[x]),s,{adapters:{transaction:async()=>{calls++;throw Object.assign(Error('unknown'),{code:'CORE_COMMIT_UNKNOWN'})},inspectCommitted:async()=>null}});
 assert.deepEqual(await h.run(),unknown);assert.equal(calls,1);
});
