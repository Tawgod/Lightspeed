import test from 'node:test';
import assert from 'node:assert/strict';
import * as security from '../.security-source/tests/fixtures/hc-secure-s25h-contract.mjs';
import {fingerprintLightspeedPayload as fp} from '../services/lightspeed/idempotency.js';
import {createCustomerAdapterM12,prepareCustomerM12,deriveCustomerScopeM12,customerTargetsM12} from '../services/lightspeed/customerAdapterM12.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
const tenant='fixture-shop',location='outlet-01',now=2000000;
const actor={type:'employee',realm:'employee',id:'e1',tenant,delegation:{kind:'none'}};
const subject={realm:'employee',id:actor.id,tenant,environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null};
const live={active:true,revoked:false,startsAt:0,expiresAt:now+100000};
const copy=x=>structuredClone(x);
const money=(saleId,eventId,amount='6',sourceId='src-'+eventId,kind='payment-reversal',ledgerId='pay-ledger')=>({saleId,customerId:'C01',orderId:'order-'+saleId,eventId,sourceId,ledgerId,kind,targetId:'PAY1',originalTransactionId:'PAY1',originalEventId:null,productId:null,quantity:null,amount,currency:'USD'});
const physical=(saleId,eventId,kind,quantity,originalEventId=null)=>({saleId,customerId:'C01',orderId:'order-'+saleId,eventId,sourceId:'src-'+eventId,ledgerId:'physical-ledger',kind,targetId:'L1',originalTransactionId:null,originalEventId,productId:'P1',quantity,amount:null,currency:null});
const a=money('0001','a'),b=money('0002','b'),dup=money('0002','dup','1',a.sourceId),small=money('0002','small','4'),fraction=money('0002','fraction','4.000001'),sameEvent=money('0002','a','1','other-source'),refund=money('0002','refund','4','refund-src','refund','refund-ledger'),settlement=money('0001','settlement','10','settle-src','settlement'),pickup=physical('0001','pickup','pickup','2'),fulfillment=physical('0001','fulfill','fulfillment','3'),undo=physical('0001','undo','pickup-reversal','1','pickup');
const events=[a,b,dup,small,fraction,sameEvent,refund,settlement,pickup,fulfillment,undo];
const input=(e,k='command-'+e.eventId,transactionId='provider-P1')=>({tenant,location,event:e,source:{system:'provider',account:'acct',eventId:e.sourceId,transactionId:e.amount===null?null:transactionId,revision:'source-v1',outlet:location,confirmed:true,eventDigest:fp(e)},allocation:e.amount===null?null:{groupId:e.kind==='settlement'?'in':'out',kind:e.kind==='settlement'?'settlement':'disbursement',originalType:'payment',originalId:'PAY1',currency:'USD',amount:'10',originalAmount:'10'},snapshots:[],approvalRef:'approval-'+k,evidenceRef:'ev1'});
const saleRecord=saleId=>{const common={saleId,customerId:'C01'};return {...common,tenant,location,orderId:'order-'+saleId,revision:'1',complete:true,lines:[{...common,id:'L1',productId:'P1',quantity:'3',ledgerId:'physical-ledger'}],payments:[{...common,id:'PAY1',amount:'10',currency:'USD',sourceConfirmed:true}],deposits:[],credits:[],events:[],sources:events.filter(e=>e.saleId===saleId).map(event=>({event,confirmed:true})),buckets:[{id:'out',kind:'disbursement',amount:'10',currency:'USD'},{id:'in',kind:'settlement',amount:'10',currency:'USD'}],allocations:[{type:'payment',targetId:'PAY1',ledgerId:'pay-ledger',kind:'disbursement',bucketId:'out'},{type:'payment',targetId:'PAY1',ledgerId:'refund-ledger',kind:'disbursement',bucketId:'out'},{type:'payment',targetId:'PAY1',ledgerId:'pay-ledger',kind:'settlement',bucketId:'in'}]}};
const read=(f,t)=>f.transaction(tx=>tx.lockDomain(t),{targets:[t]});
async function seed(f){
 const rows=new Map();
 for(const e of [a,b,settlement]){
  const i=input(e),t=customerTargetsM12(i),x=i.allocation;
  rows.set(fp(t.sale),{target:t.sale,record:saleRecord(e.saleId)});
  rows.set(fp(t.group),{target:t.group,record:{tenant,identity:{groupId:x.groupId,kind:x.kind,currency:x.currency},limit:'10',used:'0'}});
  rows.set(fp(t.original),{target:t.original,record:{tenant,identity:{system:i.source.system,account:i.source.account,transactionId:i.source.transactionId,kind:x.kind,currency:x.currency},limit:'10',used:'0'}});
 }
 const all=[...rows.values()];
 await f.transaction(async tx=>{for(const x of all){await tx.lockDomain(x.target);await tx.insertDomain({...x.target,record:x.record})}},{targets:all.map(x=>x.target)});
}
async function intent(f,e,k='command-'+e.eventId){
 const i=input(e,k);i.snapshots=await Promise.all(Object.values(customerTargetsM12(i)).map(async target=>({target,row:await read(f,target)})));return i;
}
function harness(plan,options={}){
 const execution=plan.execution;
 const facts=deriveCustomerScopeM12({command:execution,reads:plan.readEffects,inspects:plan.reconcileEffects});
 // Fixture-owned state is constructed before requests; never admit scopes from
 // the received authorization request. Deliberate mismatches test this boundary.
 const all=[...facts.executionEffects,...facts.readEffects,...facts.inspectEffects];
 const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
 const registry=[...new Map(all.map(e=>[e.operation,e])).values()].map(e=>({operation:e.operation,mode:facts.executionEffects.includes(e)?'execute':facts.readEffects.includes(e)?'read':'inspect',required:['revision','relationships','purpose','audience',...(e.amount!==null?['amount','currency']:['quantity'])],approvalRequired:facts.executionEffects.includes(e),assurance:'business'}));
 let epoch='v1',time=now;
 const state={evidenceRef:'ev1',policyVersion:epoch,employee:{realm:'employee',id:actor.id,tenant,active:true},
  session:{...live,id:'s1',actorId:actor.id,tenant,deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false},
  device:{...live,id:'d1',tenant,kind:'personal',actorId:actor.id},
  site:{...live,id:'site1',tenant,deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'},
  policy:{tenant,environment:'test',version:epoch,roles:[{id:'r',active:true,rules:all.map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:live.expiresAt,revoked:false}))}],assignments:[{id:'a',actorId:actor.id,roleId:'r',startsAt:0,expiresAt:live.expiresAt,revoked:false}],individual:[]},
  approval:{id:execution.payload.intent.approvalRef,scopeDigest:security.executionScopeDigest({actor:subject,executionDigest:fp(execution),executionEffects:facts.executionEffects}),actorId:actor.id,tenant,approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'e2',expiresAt:live.expiresAt},admittedScopes:all};
 const requests=[],clock=()=>time,readPolicyVersion=async()=>epoch;
 const evaluator=security.createOfflineAuthorization({registry,readTrustedState:async()=>state,readPolicyVersion,clock,decisionMaxMs:50});
 const authorizationOptions={security,readPolicyVersion,clock,decide:async q=>{requests.push(q);if(options.before)await options.before(q,state);const r=await evaluator(q);return options.after?options.after(q,r,{advance:()=>time++,epoch:()=>{epoch='v2'}}):r;}};
 return {authorizationOptions,state,requests};
}

function make(f,i,k='command-'+i.event.eventId,options={},extra={}){
 const plan=prepareCustomerM12({intent:i,actor,key:k}),h=harness(plan,options);
 const approval={reference:i.approvalRef,executionDigest:fp(plan.execution),reviewerId:'e2',expiresAt:live.expiresAt};
 const original={key:k,actor,intent:i};
 const adapter=createCustomerAdapterM12({...f,tenant,resolveActor:async c=>c.actor,loadOriginal:async()=>original,loadApproval:async()=>approval,authorizationOptions:h.authorizationOptions,...extra});
 return {...h,approval,original,plan,run:(request={key:k},context={actor})=>adapter.run({context,request})};
}
const pg=(name,fn)=>test(name,()=>withDisposableCorePg(async f=>{await seed(f);await fn(f)}));
const result=(state)=>({state,retryAllowed:false});
const ok={state:'verified',retryAllowed:false,replayed:false,result:{}};
const denied=result('undisclosed');
const sale=(f,e)=>read(f,customerTargetsM12(input(e)).sale);
pg('M12 cross-sale shared capacity and original provider cap with exact decimal remainder',async f=>{
 const h=make(f,await intent(f,a));assert.deepEqual(await h.run(),ok);
 const j=make(f,await intent(f,refund));assert.deepEqual(await j.run(),ok);
 const ts=customerTargetsM12(input(a));assert.equal((await read(f,ts.group)).record.used,'10');assert.equal((await read(f,ts.original)).record.used,'10');
 assert.throws(()=>prepareCustomerM12({intent:{...j.original.intent,snapshots:j.original.intent.snapshots.map(x=>fp(x.target)===fp(ts.group)?{...x,row:{...x.row,record:{...x.row.record,used:'7'}}}:x)},actor,key:'over-cap'}));
 assert.equal((await f.counts()).outbox,0);
});
pg('M12 competing cross-sale commands serialize shared capacity and roll back losing claim',async f=>{
 const h=make(f,await intent(f,a)),j=make(f,await intent(f,b));
 const results=await Promise.all([h.run(),j.run()]);assert.equal(results.filter(r=>r.state==='verified').length,1);assert.equal(results.filter(r=>r.state==='revision_conflict').length,1);
 assert.equal((await f.counts()).commands,1);assert.equal((await read(f,customerTargetsM12(input(a)).group)).record.used,'6');
 const loser=results[0].state==='verified'?b:a;const i=await intent(f,loser,'new-loser');assert.throws(()=>prepareCustomerM12({intent:i,actor,key:'new-loser'}));
});
pg('M12 duplicate source across sales and alternate event ID rejected',async f=>{
 const h=make(f,await intent(f,a)),j=make(f,await intent(f,dup));assert.deepEqual(await h.run(),ok);assert.deepEqual(await j.run(),result('revision_conflict'));
 const fresh=await intent(f,dup);assert.throws(()=>prepareCustomerM12({intent:fresh,actor,key:'new-duplicate'}));assert.equal((await sale(f,dup)).record.events.length,0);
});
pg('M12 same business event with alternate source and sale cannot be reused',async f=>{
 const h=make(f,await intent(f,a)),j=make(f,await intent(f,sameEvent,'alternate-key'),'alternate-key');
 assert.deepEqual(await h.run(),ok);assert.deepEqual(await j.run(),result('revision_conflict'));assert.equal((await sale(f,sameEvent)).record.events.length,0);
});
pg('M12 exact allocation, source digest, currency, provider identity and fractional excess fail closed',async f=>{
 const i=await intent(f,a);for(const mutate of [x=>x.source.eventDigest='wrong',x=>x.source.outlet='other',x=>x.allocation.currency='EUR',x=>x.allocation.groupId='other',x=>x.allocation.amount='11',x=>x.source.transactionId='other']){
  const v=copy(i);mutate(v);assert.throws(()=>prepareCustomerM12({intent:v,actor,key:'bad-intent'}));
 }
 await make(f,i).run();const x=await intent(f,fraction);assert.throws(()=>prepareCustomerM12({intent:x,actor,key:'fraction-key'}));assert.equal((await f.counts()).commands,1);
});
pg('M12 settlement distinct from disbursement, no actual posting or stock',async f=>{
 assert.deepEqual(await make(f,await intent(f,settlement)).run(),ok);assert.deepEqual(await make(f,await intent(f,a)).run(),ok);
 assert.equal((await read(f,customerTargetsM12(input(settlement)).group)).record.used,'10');assert.equal((await read(f,customerTargetsM12(input(a)).group)).record.used,'6');assert.equal((await f.counts()).outbox,0);
});
pg('M12 fulfillment and partial pickup reversal remain distinct evidence only',async f=>{
 for(const e of [fulfillment,pickup,undo])assert.deepEqual(await make(f,await intent(f,e)).run(),ok);
 assert.deepEqual((await sale(f,pickup)).record.events.map(e=>e.kind),['fulfillment','pickup','pickup-reversal']);assert.equal((await f.counts()).outbox,0);
});
pg('M12 original immutable approval and intent replay with empty projection',async f=>{
 const h=make(f,await intent(f,a));assert.deepEqual(await h.run(),ok);
 assert.deepEqual(await h.run(),{...ok,replayed:true});h.approval.reference='replacement';assert.deepEqual(await h.run(),denied);assert.equal((await f.counts()).commands,1);
 assert.ok(h.requests.every(q=>q.executionEffects.length===6&&q.executionEffects.every(e=>e.amount==='6'&&e.relationships.some(r=>r.type==='provider-transaction'&&r.id==='provider-P1'))));
});
pg('M12 key-only request and trusted actor binding reject caller authority',async f=>{
 const h=make(f,await intent(f,a));assert.deepEqual(await h.run({key:h.original.key,approval:h.approval}),denied);assert.deepEqual(await h.run({key:'alternate-key'}),denied);assert.deepEqual(await h.run({key:h.original.key},{actor:{...actor,id:'other'}}),denied);assert.deepEqual(await h.run({key:h.original.key},{actor:{...actor,tenant:'other'}}),denied);assert.equal((await f.counts()).commands,0);
});
pg('M12 whole-set missing grant and rich scope mismatch reject before writes',async f=>{
 const i=await intent(f,a),h=make(f,i,{before:(q,s)=>{s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.resourceType!=='customer.original')}});
 assert.deepEqual(await h.run(),denied);const j=make(f,i);j.state.admittedScopes=j.state.admittedScopes.filter(e=>e.resourceType!=='customer.allocation');assert.deepEqual(await j.run(),denied);assert.equal((await f.counts()).commands,0);
});
pg('M12 precommit revocation rolls back all sale, source and capacity writes',async f=>{
 const i=await intent(f,a);for(const before of [(q,s)=>{if(q.stage==='precommit')s.session.revoked=true},(q,s)=>{if(q.stage==='precommit')s.approval.expiresAt=now}]){
  assert.deepEqual(await make(f,i,undefined,{before}).run(),denied);
 }
 const t=customerTargetsM12(i);assert.equal((await read(f,t.group)).record.used,'0');assert.equal(await read(f,t.claim),null);assert.equal(await read(f,t.occurrence),null);assert.equal((await sale(f,a)).revision,1);assert.equal((await f.counts()).commands,0);
});
pg('M12 postcommit restricted projection does not imply rollback and replay remains empty',async f=>{
 const i=await intent(f,a),h=make(f,i,undefined,{before:(q,s)=>{if(q.stage==='projection')s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.operation!=='fixture.customer.evidence.read')}});
 assert.deepEqual(await h.run(),denied);assert.equal((await sale(f,a)).record.events.length,1);assert.deepEqual(await make(f,i).run(),{...ok,replayed:true});
});
pg('M12 uncertain acknowledgement independently inspects committed receipt without repeating writes',async f=>{
 let calls=0,inspections=0;const i=await intent(f,a);
 const h=make(f,i,undefined,{}, {transaction:async(...args)=>{calls++;await f.transaction(...args);throw Object.assign(Error('lost ack'),{code:'CORE_COMMIT_UNKNOWN'})},inspectCommitted:async m=>{inspections++;return f.inspectCommitted(m)}});
 assert.deepEqual(await h.run(),{...ok,replayed:true});assert.equal(calls,1);assert.equal(inspections,1);assert.equal((await sale(f,a)).record.events.length,1);
});
pg('M12 denied inspection never invokes inspector and unknown remains nonretryable',async f=>{
 let calls=0,inspections=0;const i=await intent(f,a),transaction=async()=>{calls++;throw Object.assign(Error('uncertain'),{code:'CORE_COMMIT_UNKNOWN'})},inspectCommitted=async()=>{inspections++;return {state:'unknown'}};
 const h=make(f,i,undefined,{before:(q,s)=>{if(q.stage==='inspection')s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.operation!=='fixture.customer.evidence.inspect')}},{transaction,inspectCommitted});
 assert.deepEqual(await h.run(),denied);assert.equal(inspections,0);assert.deepEqual(await make(f,i,undefined,{}, {transaction,inspectCommitted}).run(),result('unknown'));assert.equal(calls,2);assert.equal(inspections,1);assert.equal((await f.counts()).commands,0);
});
pg('M12 malformed decisions and unavailable authority fail closed',async f=>{
 const i=await intent(f,a);for(const options of [{after:()=>({allowed:true})},{before:()=>{throw Error('offline')}},{after:(q,r,c)=>{c.advance();return r}}])assert.deepEqual(await make(f,i,undefined,options).run(),denied);assert.equal((await f.counts()).commands,0);
});
