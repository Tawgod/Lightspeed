import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalTransactionM7,prepareExecutionM7} from '../services/lightspeed/localTransactionM7.js';
import {fingerprintLightspeedPayload as fp} from '../services/lightspeed/idempotency.js';
import {assessCumulativeEvidence} from '../services/lightspeed/customerSalesM9.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
// Disposable sale evidence ledger, NOT a financial posting adapter. All original
// transaction types and line events share one sale lock to prevent competing caps.
const target={type:'sale',id:'0001'}, tenant='fixture-shop', location='outlet-01';
const customerId='C01', saleId=target.id, common={saleId,customerId};
const actor={type:'employee',realm:'employee',tenant,id:'employee-01',delegation:{kind:'none'}};
const effect=(operation,fields)=>({operation,target,location,fields});
const initial={...common,revision:'1',lines:[{...common,id:'L1',productId:'P1',quantity:'3'}],payments:[{...common,id:'PAY1',currency:'USD',amount:'10.00',sourceConfirmed:true}],deposits:[{...common,id:'DEP1',currency:'USD',amount:'4.00',sourceConfirmed:true}],credits:[{...common,id:'CR1',currency:'USD',amount:'2.00',sourceConfirmed:true}],events:[]};
const operations={'payment-reversal':'sales.payments.reverse','deposit-reversal':'sales.deposit.reverse','credit-reversal':'store-credit.reverse',pickup:'fulfillments.pickup.confirm','pickup-reversal':'fulfillments.pickup.reverse',return:'sales.returns.execute'};
const readOps={'payment-reversal':'sales.payments.read','deposit-reversal':'sales.deposit.read','credit-reversal':'store-credit.read',pickup:'fulfillments.read','pickup-reversal':'fulfillments.read',return:'sales.returns.read'};
const event=(kind,targetId,details)=>({...common,kind,targetId,...details});
const payment=(eventId,amount)=>event('payment-reversal','PAY1',{eventId,amount,currency:'USD'});
const prep=(e,key,revision=1,extra={})=>prepareExecutionM7({tenant,scope:'test.customer.evidence.m10',key,actor,targets:[target],effects:[effect(operations[e.kind],['evidence'])],expectedRevisions:[{target,revision}],payload:{event:e,location,customerId},...extra});
const approval=execution=>({reference:'approval-'+execution.key,executionDigest:fp(execution),reviewerId:'reviewer-01',expiresAt:2000});
const denied=p=>assert.rejects(p,{code:'CORE_FORBIDDEN',outcome:'undisclosed'});
async function seed(f){await f.transaction(async tx=>{await tx.lockDomain(target);await tx.insertDomain({...target,record:initial});},{targets:[target]});}
async function current(f){return f.transaction(tx=>tx.lockDomain(target),{targets:[target]});}
function next(command,evidence){
 const row=evidence[0]?.row, e=command.payload.event;
 if(!row||command.payload.customerId!==customerId||command.payload.location!==location||row.record.customerId!==customerId||row.record.saleId!==saleId||!Object.hasOwn(operations,e.kind))throw Error('Wrong scope');
 if(fp(command.effects)!==fp([effect(operations[e.kind],['evidence'])]))throw Error('Wrong effect');
 if(e.saleId!==saleId||e.customerId!==customerId)throw Error('Wrong association');
 if(e.kind.endsWith('-reversal')&&e.kind!=='pickup-reversal'&&e.originalEventId!==undefined)throw Error('Use exact original transaction target, not alternate event reference');
 const revision=String(row.revision);
 if(row.record.revision!==revision)throw Error('Stale evidence');
 const prior=row.record.events;
 if(prior.some(p=>p.eventId===e.eventId))throw Error('Duplicate evidence event');
 const candidate={...row.record,events:[...prior,{...e,sequence:prior.length+1}]};
 // Explicit completeness is a trusted disposable fixture fact only.
 assessCumulativeEvidence({...candidate,coverage:{...common,revision,complete:true}});
 return {...candidate,revision:String(row.revision+1)};
}
function args(execution,overrides={}){
 const op=readOps[execution.payload.event.kind];
 return {execution,approval:approval(execution),readEffects:[effect(op,['id'])],reconcileEffects:[effect('audit.read',['id'])],
 verifyExecution:({command,evidence})=>{try{next(command,evidence);return true;}catch{return false;}},
 apply:async(tx,command,evidence)=>({id:command.payload.event.eventId,revision:await tx.replaceDomain({...target,expectedRevision:evidence[0].row.revision,record:next(command,evidence)})}),...overrides};
}
const make=(f,extra={})=>createLocalTransactionM7({...f,tenant,authorizeExecution:()=>true,verifyApproval:({approval})=>approval.expiresAt>1000,authorizeAccess:()=>true,receiptSchema:{version:'customer.evidence.v1',fields:['id','revision']},projectResult:(r,{readEffects})=>Object.fromEntries(Object.entries(r).filter(([k])=>readEffects.some(e=>e.fields.includes(k)))),...extra});
const pg=(name,fn)=>test(name,()=>withDisposableCorePg(async f=>{await seed(f);await fn(f);}));
pg('competing distinct reversal commands serialize and cannot over-refund original payment',async f=>{
 const run=make(f),a=prep(payment('E1','7.00'),'payment-001'),b=prep(payment('E2','6.00'),'payment-002');
 const results=await Promise.allSettled([run(args(a)),run(args(b))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await current(f)).record.events.length,1);
 const loser=results[0].status==='rejected'?a:b;
 await denied(run(args(prep(loser.payload.event,'payment-retry',2))));
 assert.equal((await current(f)).record.events.length,1);assert.equal((await f.counts()).commands,1);
});
pg('same original payment exact replay changes access without applying again; alternate event ID cannot exceed cap',async f=>{
 const run=make(f),x=prep(payment('E1','10.00'),'payment-003');
 assert.deepEqual(await run(args(x)),{replayed:false,result:{id:'E1'}});
 assert.deepEqual(await run(args(x,{readEffects:[effect('sales.payments.read',['id','revision'])],apply:()=>assert.fail('reapplied')})),{replayed:true,result:{id:'E1',revision:2}});
 await denied(run(args(prep(payment('E2','0.01'),'payment-004',2))));
 assert.equal((await current(f)).record.events.length,1);
});
pg('original transaction linkage and separate deposit credit limits',async f=>{
 const run=make(f);
 await denied(run(args(prep(event('payment-reversal','DEP1',{eventId:'E1',amount:'1',currency:'USD'}),'wrong-original'))));
 await run(args(prep(event('deposit-reversal','DEP1',{eventId:'E2',amount:'4',currency:'USD'}),'deposit-001')));
 await run(args(prep(event('credit-reversal','CR1',{eventId:'E3',amount:'2',currency:'USD'}),'credit-0001',2)));
 await denied(run(args(prep(event('credit-reversal','CR1',{eventId:'E4',amount:'0.01',currency:'USD'}),'credit-0002',3))));
 const row=await current(f);assert.equal(row.record.events.length,2);assert.equal((await f.counts()).outbox,0);
});
pg('pickup reversal original linkage and merchandise evidence never adjust stock',async f=>{
 const run=make(f);
 await run(args(prep(event('pickup','L1',{eventId:'PK1',productId:'P1',quantity:'2'}),'pickup-0001')));
 await denied(run(args(prep(event('pickup-reversal','L1',{eventId:'PK2',originalEventId:'missing',productId:'P1',quantity:'1'}),'pickup-0002',2))));
 await run(args(prep(event('pickup-reversal','L1',{eventId:'PK3',originalEventId:'PK1',productId:'P1',quantity:'1'}),'pickup-0003',2)));
 await run(args(prep(event('return','L1',{eventId:'RET1',productId:'P1',quantity:'1'}),'return-0001',3)));
 const row=await current(f);const out=assessCumulativeEvidence({...row.record,coverage:{...common,revision:row.record.revision,complete:true}});
 assert.equal(out.items[0].observedPickup,'1.000000');assert.equal(out.items[0].observedReturn,'1.000000');assert.equal(out.stockEffect,null);assert.equal(out.refundAuthorized,false);assert.equal((await f.counts()).outbox,0);
});
pg('independent execution and projection denial across consumer origins',async f=>{
 const x=prep(payment('E1','2'),'payment-005');
 for(const tool of ['Special Orders','Consignment','Split Recall','API','import','automation']){
  await denied(make(f,{authorizeExecution:()=>false})(args(x,{tool})));
 }
 assert.equal((await current(f)).record.events.length,0);
 await denied(make(f,{authorizeAccess:()=>false})(args(x)));
 assert.equal((await current(f)).record.events.length,1);
 assert.equal((await make(f)(args(x))).replayed,true);
});
pg('approval expiry at commit rolls back evidence and claim',async f=>{
 const x=prep(payment('E1','2'),'payment-006');
 await denied(make(f,{verifyApproval:({stage})=>stage!=='beforeCommit'})(args(x)));
 assert.equal((await current(f)).revision,1);assert.equal((await f.counts()).commands,0);
});
pg('unknown commit needs independent inspection; no blind repeat',async f=>{
 const x=prep(payment('E1','2'),'payment-007');let inspections=0;
 const transaction=async(...a)=>{await f.transaction(...a);throw Object.assign(Error('fixture lost acknowledgement'),{code:'CORE_COMMIT_UNKNOWN'});};
 await denied(make(f,{transaction,authorizeAccess:({kind})=>kind!=='inspect',inspectCommitted:async m=>{inspections++;return f.inspectCommitted(m);}})(args(x)));
 assert.equal(inspections,0);assert.equal((await current(f)).record.events.length,1);
 assert.equal((await make(f)(args(x))).replayed,true);
});
pg('changed effects, actor and replacement approval cannot bypass original binding',async f=>{
 const x=prep(payment('E1','2'),'payment-008');
 await denied(make(f)(args(prep(payment('E1','2'),'wrong-effect',1,{effects:[effect('sales.read',['evidence'])]}))));
 await make(f)(args(x));
 await denied(make(f)(args(x,{approval:{...approval(x),reference:'replacement'}})));
 const other=prep(payment('E1','2'),'payment-008',1,{actor:{...actor,id:'employee-02'}});
 await denied(make(f)(args(other)));assert.equal((await current(f)).record.events.length,1);
});
