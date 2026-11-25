import test from 'node:test';
import assert from 'node:assert/strict';
import * as security from '../.security-source/tests/fixtures/hc-secure-s25h-contract.mjs';
import {createAuthorizationM8} from '../services/lightspeed/authorizationM8.js';
import {fingerprintLightspeedPayload as fp} from '../services/lightspeed/idempotency.js';
import {createCustomerEvidenceM11,prepareCustomerEvidenceM11,deriveCustomerScopeM11,customerEvidenceAccessM11} from '../services/lightspeed/customerSalesM11.js';
import {assessCumulativeEvidence} from '../services/lightspeed/customerSalesM9.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
const tenant='fixture-shop',location='outlet-01',target={type:'sale',id:'0001'},now=2000000;
const common={saleId:target.id,customerId:'C01'},orderId='O001';
const actor={type:'employee',realm:'employee',id:'e1',tenant,delegation:{kind:'none'}};
const subject={realm:'employee',id:actor.id,tenant,environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null};
const live={active:true,revoked:false,startsAt:0,expiresAt:now+100000};
const money=(eventId,kind,targetId,ledgerId,amount,currency='USD')=>({...common,orderId,eventId,sourceId:'src-'+eventId,ledgerId,kind,targetId,originalTransactionId:targetId,originalEventId:null,productId:null,quantity:null,amount,currency});
const line=(eventId,kind,quantity,originalEventId=null)=>({...common,orderId,eventId,sourceId:'src-'+eventId,ledgerId:'fulfill-ledger',kind,targetId:'L1',originalTransactionId:null,originalEventId,productId:'P1',quantity,amount:null,currency:null});
const p=money('pay-r1','payment-reversal','PAY1','pay-ledger','6.00');
const dep=money('dep-r1','deposit-reversal','DEP1','dep-ledger','5.00');
const refund=money('refund1','refund','DEP1','dep-ledger','5.00');
const credit=money('credit1','credit-issue','DEP1','dep-ledger','4.00');
const creditReverse=money('credit-r1','credit-reversal','CR1','credit-ledger','2.00');
const settle=money('settle1','settlement','PAY1','pay-ledger','10.00');
const settleAgain=money('settle2','settlement','PAY1','pay-ledger','0.01');
const wrongCurrency=money('wrong-currency','refund','PAY1','pay-ledger','1','EUR');
const wrongLedger=money('wrong-ledger','refund','PAY1','dep-ledger','1');
const excessive=money('excess','payment-reversal','PAY1','pay-ledger','10.000001');
const fulfillment=line('fulfill1','fulfillment','3');
const pickup=line('pickup1','pickup','2');
const undo=line('undo1','pickup-reversal','1','pickup1');
const returned=line('return1','return','1');
const missing=line('missing1','pickup-reversal','1','missing');
const events=[p,dep,refund,credit,creditReverse,settle,settleAgain,wrongCurrency,wrongLedger,excessive,fulfillment,pickup,undo,returned,missing];
const original=(id,amount)=>({...common,id,amount,currency:'USD',sourceConfirmed:true});
const allocation=(type,targetId,ledgerId,kind,bucketId)=>({type,targetId,ledgerId,kind,bucketId});
const seedRecord={...common,tenant,location,orderId,revision:'1',complete:true,lines:[{...common,id:'L1',productId:'P1',quantity:'3',ledgerId:'fulfill-ledger'}],payments:[original('PAY1','10')],deposits:[original('DEP1','5')],credits:[original('CR1','2')],events:[],
 sources:events.map(event=>({event,confirmed:true})),
 buckets:[{id:'shared-out',kind:'disbursement',amount:'10',currency:'USD'},{id:'pay-in',kind:'settlement',amount:'10',currency:'USD'}],
 allocations:[allocation('payment','PAY1','pay-ledger','disbursement','shared-out'),allocation('deposit','DEP1','dep-ledger','disbursement','shared-out'),allocation('credit','CR1','credit-ledger','disbursement','shared-out'),allocation('payment','PAY1','pay-ledger','settlement','pay-in')]
};
const prep=(event,revision=1,key='command-'+event.eventId)=>prepareCustomerEvidenceM11({tenant,actor,key,location,revision,event});
const approve=execution=>({reference:'approval-'+execution.key,executionDigest:fp(execution),reviewerId:'e2',expiresAt:live.expiresAt});
const denied=p=>assert.rejects(p,e=>e.code==='CORE_FORBIDDEN'&&e.outcome==='undisclosed');
function harness(execution,options={}){
 const access=customerEvidenceAccessM11(execution);
 const facts=deriveCustomerScopeM11({command:execution,reads:access.readEffects,inspects:access.reconcileEffects,evidenceRef:'ev1'});
 // Fixture-owned state is constructed before requests; never admit scopes from
 // the received authorization request. Deliberate mismatches test this boundary.
 const all=[...facts.executionEffects,...facts.readEffects,...facts.inspectEffects];
 const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
 const registry=all.map(e=>({operation:e.operation,mode:facts.executionEffects.includes(e)?'execute':facts.readEffects.includes(e)?'read':'inspect',required:['revision','relationships','purpose','audience',...(e.amount!==null?['amount','currency']:['quantity'])],approvalRequired:facts.executionEffects.includes(e),assurance:'business'}));
 let epoch='v1',time=now;
 const state={evidenceRef:'ev1',policyVersion:epoch,employee:{realm:'employee',id:actor.id,tenant,active:true},
  session:{...live,id:'s1',actorId:actor.id,tenant,deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false},
  device:{...live,id:'d1',tenant,kind:'personal',actorId:actor.id},
  site:{...live,id:'site1',tenant,deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'},
  policy:{tenant,environment:'test',version:epoch,roles:[{id:'r',active:true,rules:all.map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:live.expiresAt,revoked:false}))}],assignments:[{id:'a',actorId:actor.id,roleId:'r',startsAt:0,expiresAt:live.expiresAt,revoked:false}],individual:[]},
  approval:{id:approve(execution).reference,scopeDigest:security.executionScopeDigest({actor:subject,executionDigest:fp(execution),executionEffects:facts.executionEffects}),actorId:actor.id,tenant,approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'e2',expiresAt:live.expiresAt},admittedScopes:all};
 const requests=[],clock=()=>time,readPolicyVersion=async()=>epoch;
 const evaluator=security.createOfflineAuthorization({registry,readTrustedState:async()=>state,readPolicyVersion,clock,decisionMaxMs:50});
 const authorization=createAuthorizationM8({security,readPolicyVersion,clock,deriveScope:input=>{
  const derived=deriveCustomerScopeM11({...input,evidenceRef:'ev1'});return options.derive?options.derive(derived):derived;
 },decide:async q=>{requests.push(q);if(options.before)await options.before(q,state);const r=await evaluator(q);return options.after?options.after(q,r,{advance:()=>time++,epoch:()=>{epoch='v2'}}):r;}});
 return {authorization,state,requests};
}
const current=f=>f.transaction(tx=>tx.lockDomain(target),{targets:[target]});
const pg=(name,fn)=>test(name,()=>withDisposableCorePg(async f=>{
 await f.transaction(async tx=>{await tx.lockDomain(target);await tx.insertDomain({...target,record:seedRecord});},{targets:[target]});await fn(f);
}));
const make=(f,x,options={},extra={})=>{const h=harness(x,options);const run=createCustomerEvidenceM11({...f,tenant,authorization:h.authorization,...extra});return {...h,run:(approval=approve(x))=>run({execution:x,approval})};};
const submit=(f,e,r=1,key)=>make(f,prep(e,r,key)).run();
pg('M11 whole rich sets preserve exact sale, customer, order, ledger, amount, original and source; replay is minimal',async f=>{
 const x=prep(p),h=make(f,x);
 assert.deepEqual(await h.run(),{replayed:false,result:{id:p.eventId}});
 assert.deepEqual(await h.run(),{replayed:true,result:{id:p.eventId}});
 assert.equal((await current(f)).record.events.length,1);
 assert.ok(h.requests.every(q=>q.executionEffects.length===2&&q.executionEffects.every(e=>e.amount==='6'&&e.currency==='USD'&&e.resourceId==='0001'&&e.revision==='1'&&e.relationships.some(r=>r.type==='original-transaction'&&r.id==='PAY1')&&e.relationships.some(r=>r.type==='order'&&r.id===orderId))));
 assert.equal(new Set(h.requests.map(q=>q.requestId)).size,h.requests.length);
 assert.ok(h.requests.some(q=>q.stage==='precommit'));assert.ok(h.requests.some(q=>q.stage==='projection'));assert.equal((await f.counts()).outbox,0);
});
pg('M11 competing payment reversal and deposit refund share allocation cap and stale revision rolls back',async f=>{
 const a=make(f,prep(p)),b=make(f,prep(refund));
 const result=await Promise.allSettled([a.run(),b.run()]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await current(f)).revision,2);
 const loser=result[0].status==='rejected'?p:refund;
 await denied(submit(f,loser,2,'loser-new-key'));
 assert.equal((await current(f)).record.events.length,1);assert.equal((await f.counts()).commands,1);
});
pg('M11 credit issue, deposit reversal, refund and payment reversal cannot independently spend same allocation',async f=>{
 await submit(f,p);await submit(f,credit,2);
 await denied(submit(f,refund,3));await denied(submit(f,dep,3));await denied(submit(f,creditReverse,3));
 assert.equal((await current(f)).record.events.length,2);assert.equal((await f.counts()).outbox,0);
});
pg('M11 settlement evidence is distinct and cannot be counted twice or exceed original capacity',async f=>{
 await submit(f,settle);await denied(submit(f,settleAgain,2));
 await denied(submit(f,{...settle,eventId:'alternate'},2,'alternate-source'));
 await submit(f,p,2);assert.equal((await current(f)).record.events.length,2);
});
pg('M11 currency, original ledger and exact fractional excess mismatches fail without durable effects',async f=>{
 for(const e of [wrongCurrency,wrongLedger,excessive,{...p,originalTransactionId:'DEP1',targetId:'DEP1'},{...p,orderId:'wrong-order'}])await denied(submit(f,e));
 assert.equal((await current(f)).revision,1);assert.equal((await f.counts()).commands,0);
});
pg('M11 fulfillment is not pickup, partial pickup reversal is linked, and return does not authorize stock or refund',async f=>{
 await submit(f,fulfillment);await submit(f,pickup,2);await denied(submit(f,missing,3));
 await submit(f,undo,3);await submit(f,returned,4);
 const r=(await current(f)).record;
 const result=assessCumulativeEvidence({...r,events:r.events.filter(e=>e.kind!=='fulfillment').map((e,i)=>({...e,sequence:i+1})),coverage:{...common,revision:r.revision,complete:true}});
 assert.equal(result.items[0].observedPickup,'1.000000');assert.equal(result.items[0].observedReturn,'1.000000');assert.equal(result.stockEffect,null);assert.equal(result.refundAuthorized,false);assert.equal((await f.counts()).outbox,0);
});
pg('M11 stale revision cannot record another source',async f=>{
 await submit(f,p);await assert.rejects(submit(f,credit,1),{code:'CORE_REVISION_CONFLICT'});
 assert.equal((await current(f)).record.events.length,1);
});
pg('M11 missing independent source effect denies entire command',async f=>{
 const h=make(f,prep(p),{before:(q,s)=>{s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.operation!=='fixture.customer.evidence.record')}});
 await denied(h.run());assert.equal((await f.counts()).commands,0);
});
pg('M11 rich amount or relationship mismatch denied despite matching narrow role tuple',async f=>{
 for(const derive of [
  x=>({...x,executionEffects:x.executionEffects.map(e=>({...e,amount:'7'}))}),
  x=>({...x,executionEffects:x.executionEffects.map(e=>({...e,relationships:e.relationships.map(r=>r.type==='customer'?{...r,id:'other'}:r)}))})
 ])await denied(make(f,prep(p),{derive}).run());
 assert.equal((await f.counts()).commands,0);
});
pg('M11 revoked session or expired approval at precommit atomically rolls back evidence and claim',async f=>{
 for(const before of [(q,s)=>{if(q.stage==='precommit')s.session.revoked=true},(q,s)=>{if(q.stage==='precommit')s.approval.expiresAt=now}])await denied(make(f,prep(p),{before}).run());
 assert.equal((await current(f)).revision,1);assert.equal((await f.counts()).commands,0);
});
pg('M11 replacement approval cannot replay an existing committed command',async f=>{
 const x=prep(p),h=make(f,x);await h.run();
 h.state.approval.id='replacement';await denied(h.run({...approve(x),reference:'replacement'}));
 assert.equal((await current(f)).record.events.length,1);
});
pg('M11 postcommit projection denial is not rollback; authorized replay does not reapply',async f=>{
 const x=prep(p),h=make(f,x,{before:(q,s)=>{if(q.stage==='projection')s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.operation!=='fixture.customer.evidence.read')}});
 await denied(h.run());assert.equal((await current(f)).record.events.length,1);
 assert.equal((await make(f,x).run()).replayed,true);assert.equal((await f.counts()).commands,1);
});
pg('M11 unknown commit requires independent inspection; denied inspection never invokes inspector',async f=>{
 const x=prep(p);let inspections=0,calls=0;
 const transaction=async(...args)=>{calls++;await f.transaction(...args);throw Object.assign(Error('lost ack'),{code:'CORE_COMMIT_UNKNOWN'});};
 const h=make(f,x,{before:(q,s)=>{if(q.stage==='inspection')s.policy.roles[0].rules=s.policy.roles[0].rules.filter(r=>r.effect.operation!=='fixture.customer.evidence.inspect')}},{transaction,inspectCommitted:async m=>{inspections++;return f.inspectCommitted(m)}});
 await denied(h.run());assert.equal(inspections,0);assert.equal(calls,1);assert.equal((await current(f)).record.events.length,1);
});
pg('M11 unconfirmed inspection remains unknown and never repeats transaction',async f=>{
 let calls=0,inspections=0;const x=prep(p);
 const h=make(f,x,{}, {transaction:async()=>{calls++;throw Object.assign(Error('uncertain'),{code:'CORE_COMMIT_UNKNOWN'})},inspectCommitted:async()=>{inspections++;return {state:'unknown'}}});
 await assert.rejects(h.run(),{code:'CORE_COMMIT_UNKNOWN',outcome:'unknown'});
 assert.equal(calls,1);assert.equal(inspections,1);assert.equal((await current(f)).record.events.length,0);
});
pg('M11 successful independent inspection recovers original receipt after lost acknowledgement',async f=>{
 let calls=0;const x=prep(p);
 const h=make(f,x,{}, {transaction:async(...a)=>{calls++;await f.transaction(...a);throw Object.assign(Error('uncertain'),{code:'CORE_COMMIT_UNKNOWN'})}});
 assert.deepEqual(await h.run(),{replayed:true,result:{id:p.eventId}});
 assert.equal(calls,1);assert.ok(h.requests.some(q=>q.stage==='inspection'));assert.equal((await current(f)).record.events.length,1);
});
pg('M11 malformed and stale responses fail closed',async f=>{
 for(const after of [()=>({allowed:true}),(q,r,c)=>{c.epoch();return r},(q,r,c)=>{c.advance();return r}])await denied(make(f,prep(p),{after}).run());
 assert.equal((await f.counts()).commands,0);
});
test('M11 explicit payload schema rejects raw credentials and unknown amounts',()=>{
 assert.throws(()=>prep({...p,rawPaymentCredential:'not-allowed'}));
 assert.throws(()=>prep({...p,amount:null}));
});
