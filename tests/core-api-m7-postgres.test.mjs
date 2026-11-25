import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalTransactionM7,prepareExecutionM7} from '../services/lightspeed/localTransactionM7.js';
import {fingerprintLightspeedPayload as fp} from '../services/lightspeed/idempotency.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
const target={type:'product',id:'0001'};
const effect=(operation,fields=['id'])=>({operation,target,location:'store',fields});
const execution=prepareExecutionM7({tenant:'shop',scope:'test.catalog',key:'fixture-001',actor:{type:'employee',realm:'employee',tenant:'shop',id:'a',delegation:{kind:'none'}},targets:[target],effects:[effect('catalog.product.update',['cost']),effect('catalog.product.cost.modify',['cost'])],payload:{cost:'12.00'},expectedRevisions:[{target,revision:null}]});
const approval={reference:'approval-1',executionDigest:fp(execution),reviewerId:'b',expiresAt:2000};
const base={execution,approval,readEffects:[effect('catalog.product.read')],reconcileEffects:[effect('audit.read')],verifyExecution:()=>true,apply:async tx=>({id:target.id,revision:await tx.insertDomain({...target,record:{cost:'12.00'}})})};
const make=(f,extra={})=>createLocalTransactionM7({...f,tenant:'shop',authorizeExecution:()=>true,verifyApproval:({approval})=>approval.expiresAt>1000,authorizeAccess:()=>true,receiptSchema:{version:'receipt.v1',fields:['id','revision']},projectResult:(r,{readEffects})=>Object.fromEntries(Object.entries(r).filter(([k])=>readEffects.some(e=>e.fields.includes(k)))),...extra});
const pg=(name,fn)=>test(name,()=>withDisposableCorePg(fn));
const denied=p=>assert.rejects(p,e=>e.code==='CORE_FORBIDDEN'&&e.outcome==='undisclosed');
test('M7 execution digest excludes access and approval, normalizes effect ordering',()=>{
 assert.equal(fp(prepareExecutionM7({...execution,effects:[...execution.effects].reverse()})),fp(execution));
 assert.notEqual(fp(prepareExecutionM7({...execution,payload:{cost:'13.00'}})),fp(execution));
 assert.ok(Object.isFrozen(execution.effects[0].fields));
});
pg('M7 changed authorized access replays without effect',async f=>{
 const run=make(f);assert.deepEqual(await run(base),{replayed:false,result:{id:'0001'}});
 assert.deepEqual(await run({...base,readEffects:[effect('catalog.product.read',['revision','id'])],apply:()=>assert.fail('reapplied')}),{replayed:true,result:{id:'0001',revision:1}});
 assert.equal((await f.counts()).commands,1);
});
pg('M7 cross-tool exact underlying cost denial',async f=>{
 for(const tool of ['Product Manager','Scanner','Special Orders','Purchasing','Import','Automation']){
 const run=make(f,{authorizeExecution:({effect})=>effect.operation!=='catalog.product.cost.modify'});
 await denied(run({...base,tool}));}
 assert.equal((await f.counts()).commands,0);
});
pg('M7 precommit expired approval rolls back',async f=>{
 await denied(make(f,{verifyApproval:({stage})=>stage!=='beforeCommit'})(base));
 assert.equal((await f.typedCounts()).typed_domain,0);assert.equal((await f.counts()).commands,0);
});
pg('M7 independent read denial does not disclose or rollback',async f=>{
 await denied(make(f,{authorizeAccess:()=>false})(base));
 assert.equal((await f.counts()).commands,1);
 assert.equal((await make(f)(base)).replayed,true);
});
pg('M7 replacement approval and cross actor replay denied',async f=>{
 const run=make(f);await run(base);
 await denied(run({...base,approval:{...approval,reference:'replacement'}}));
 const other=prepareExecutionM7({...execution,actor:{...execution.actor,id:'other'}});
 await denied(run({...base,execution:other,approval:{...approval,executionDigest:fp(other)}}));
 assert.equal((await f.counts()).commands,1);
});
pg('M7 projection rejects unapproved fields and values',async f=>{
 await denied(make(f,{projectResult:r=>r})(base));
 await denied(make(f,{projectResult:()=>({id:'wrong'})})(base));
 assert.equal((await f.counts()).commands,1);
});
pg('M7 unknown commit inspection requires separate authority',async f=>{
 let inspections=0;
 const transaction=async(...args)=>{await f.transaction(...args);throw Object.assign(Error('lost ack'),{code:'CORE_COMMIT_UNKNOWN'});};
 await denied(make(f,{transaction,authorizeAccess:({kind})=>kind!=='inspect',inspectCommitted:async m=>{inspections++;return f.inspectCommitted(m);}})(base));
 assert.equal(inspections,0);
 assert.equal((await make(f,{transaction})(base)).replayed,true);
 assert.equal((await f.counts()).commands,1);
});
pg('M7 unrelated access target rejected and service gated',async f=>{
 await assert.rejects(make(f)({...base,readEffects:[{...effect('catalog.product.read'),target:{type:'product',id:'other'}}]}),TypeError);
 assert.throws(()=>prepareExecutionM7({...execution,actor:{...execution.actor,type:'service',realm:'service'}}),TypeError);
 assert.equal((await f.counts()).commands,0);
});
pg('M7 post-lock changed effects denied and original binding preserved',async f=>{
 await denied(make(f)({...base,verifyExecution:()=>false}));
 assert.equal((await f.counts()).commands,0);
 await make(f)(base);
 await denied(make(f,{verifyApproval:()=>false})(base));
 assert.equal((await f.counts()).commands,1);
});
