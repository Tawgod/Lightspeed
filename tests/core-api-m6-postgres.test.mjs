import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalTransactionM6} from '../services/lightspeed/localTransactionM6.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
const t={type:'invoice',id:'001'};
const effect=(operation,target=t)=>({operation,target,location:'store',fields:['review']});
const base={scope:'test.invoice',key:'fixture-001',actor:{type:'employee',id:'a',realm:'employee',tenant:'shop',delegation:{kind:'none'}},targets:[t],effects:[effect('invoice.review')],readEffects:[effect('invoice.read')],reconcileEffects:[effect('audit.reconcile')],expectedRevisions:[{target:t,revision:null}],payload:{id:'001'},receiptFields:['id','revision'],verifyLocked:()=>true,apply:async(tx)=>{const revision=await tx.insertDomain({...t,record:{status:'reviewed'}});await tx.enqueueCanonical({id:'event-001',record:{id:t.id}});return {id:t.id,revision};},projectResult:r=>r};
const make=(f,extra={})=>createLocalTransactionM6({...f,tenant:'shop',authorize:()=>true,authorizeRead:()=>true,authorizeReconcile:()=>true,...extra});
const pg=(name,fn)=>test(name,async()=>withDisposableCorePg(fn));
const reject=(p,code,outcome)=>assert.rejects(p,e=>e.code===code&&(!outcome||e.outcome===outcome));
pg('M6 concurrent missing key locks serialize competing commands and same key replays',async f=>{
 const run=make(f);const results=await Promise.all([run(base),run(base)]);assert.equal(results.filter(r=>r.replayed).length,1);
 await reject(run({...base,key:'fixture-002'}),'CORE_REVISION_CONFLICT');assert.equal((await f.typedCounts()).typed_domain,1);
 assert.deepEqual(await f.counts(),{commands:1,domain:0,outbox:1,audit:1});
});
pg('M6 revision update and typed target enforcement',async f=>{
 const run=make(f);await run(base);
 const b={...base,key:'fixture-002',expectedRevisions:[{target:t,revision:1}],apply:async tx=>({id:t.id,revision:await tx.replaceDomain({...t,expectedRevision:1,record:{status:'approved'}})})};
 assert.equal((await run(b)).result.revision,2);await reject(run({...b,key:'fixture-003'}),'CORE_REVISION_CONFLICT');
 await assert.rejects(run({...b,key:'fixture-004',expectedRevisions:[{target:t,revision:2}],apply:tx=>tx.insertDomain({type:'other',id:'x',record:{}})}),/unlocked/);
});
for(const stage of ['beforeClaim','afterClaim','afterLocks','beforeCommit'])pg('M6 denial at '+stage+' rolls back',async f=>{
 await reject(make(f,{authorize:r=>r.stage!==stage})(base),'CORE_FORBIDDEN','not_committed');
 assert.deepEqual(await f.counts(),{commands:0,domain:0,outbox:0,audit:1});assert.equal((await f.typedCounts()).typed_domain,0);
});
pg('M6 replay requires fresh execution and independent read projection',async f=>{
 const run=make(f);await run(base);
 await reject(make(f,{authorizeRead:()=>false})({...base,apply:()=>assert.fail('reapplied')}),'CORE_FORBIDDEN','committed');
 await reject(make(f,{authorize:r=>r.stage!=='beforeDisclosure'})(base),'CORE_FORBIDDEN','committed');
 assert.equal((await run({...base,projectResult:r=>({id:r.id})})).replayed,true);
 assert.equal((await f.counts()).commands,1);
});
pg('M6 actor, effect and target changes conflict; tenant and realm mismatch reject',async f=>{
 const run=make(f);await run(base);
 await reject(run({...base,actor:{...base.actor,id:'b'}}),'CORE_KEY_CONFLICT');
 await reject(run({...base,effects:[effect('invoice.approve')]}),'CORE_KEY_CONFLICT');
 const other={type:'invoice',id:'002'};await reject(run({...base,targets:[other],effects:[effect('invoice.review',other)],readEffects:[effect('invoice.read',other)],reconcileEffects:[effect('audit.reconcile',other)],expectedRevisions:[{target:other,revision:null}]}),'CORE_KEY_CONFLICT');
 await assert.rejects(run({...base,actor:{...base.actor,tenant:'other'}}),TypeError);await assert.rejects(run({...base,actor:{...base.actor,realm:'service'}}),TypeError);
 await assert.rejects(run({...base,effects:[effect('invoice.review',other)]}),TypeError);
});
pg('M6 locked effect and approval verification fail closed',async f=>{
 await reject(make(f)({...base,verifyLocked:()=>false}),'CORE_EFFECT_CHANGED');assert.equal((await f.counts()).commands,0);
 for(const invalid of ['expired','revoked','wrong-actor','wrong-revision'])await reject(make(f)({...base,approval:{status:invalid},verifyLocked:({command})=>command.approval.status==='approved'}),'CORE_EFFECT_CHANGED');
});
pg('M6 exact effect tuples, restrictions, session and delegation checked by fixture',async f=>{
 const effects=[effect('catalog.product.cost.modify'),effect('purchasing.po.line.cost.modify')];
 for(const denied of ['purchasing.po.line.cost.modify','catalog.product.cost.modify'])await reject(make(f,{authorize:({effect})=>effect.operation!==denied})({...base,effects}),'CORE_FORBIDDEN');
 for(const condition of ['session','site','device','restriction','alias','delegation'])await reject(make(f,{authorize:()=>condition==='allowed'})(base),'CORE_FORBIDDEN');
 await reject(make(f,{authorize:()=>({allow:true})})(base),'CORE_FORBIDDEN');
 await assert.rejects(make(f)({...base,actor:{...base.actor,delegation:{kind:'delegated'}}}),TypeError);
});
pg('M6 minimal receipt rejects raw fields and rolls back',async f=>{
 await reject(make(f)({...base,apply:async tx=>{await base.apply(tx);return {id:t.id,revision:1,privateNote:'no'};}}),'CORE_RECEIPT_INVALID');assert.equal((await f.counts()).commands,0);
});
pg('M6 canonical outbox conflict and immutable audit',async f=>{
 const run=make(f);await run(base);
 const b={...base,key:'fixture-002',expectedRevisions:[{target:t,revision:1}],apply:async tx=>{await tx.enqueueCanonical({id:'event-001',record:{id:t.id}});return {id:t.id,revision:1};}};
 await run(b);await reject(run({...b,key:'fixture-003',apply:async tx=>{await tx.enqueueCanonical({id:'event-001',record:{id:'changed'}});return {id:t.id,revision:1};}}),'CORE_OUTBOX_CONFLICT');
 for(const probe of [f.attemptAuditUpdate,f.attemptAuditDelete,f.attemptAuditTruncate])await assert.rejects(probe(),/immutable/);
 assert.equal((await f.counts()).outbox,1);
});
pg('M6 unknown commit requires independent reconciliation and never repeats',async f=>{
 let executions=0;
 const transaction=async(...args)=>{await f.transaction(...args);throw Object.assign(Error('lost ack'),{code:'CORE_COMMIT_UNKNOWN'});};
 const run=make(f,{transaction});const c={...base,apply:async(...a)=>{executions++;return base.apply(...a);}};
 assert.equal((await run(c)).replayed,true);assert.equal(executions,1);
 await reject(make(f,{transaction,authorizeReconcile:()=>false})(c),'CORE_FORBIDDEN','unknown');
 await reject(make(f,{transaction:async()=>{throw Object.assign(Error('unknown'),{code:'CORE_COMMIT_UNKNOWN'});},inspectCommitted:()=>({state:'unknown'})})(c),'CORE_COMMIT_UNKNOWN','unknown');
 assert.equal(executions,1);
});
pg('M6 projection failure is committed and does not repeat effects',async f=>{
 const run=make(f);await reject(run({...base,projectResult:()=>{throw Error('projection');}}),'CORE_PROJECTION_FAILED','committed');assert.equal((await run(base)).replayed,true);
});

pg('M6 frozen receipt allowlist survives fresh commit and reordered replay; exact keys enforced',async f=>{
 const run=make(f);
 const fields=Object.freeze(['revision','id']);
 const c={...base,receiptFields:fields,apply:async(tx,command)=>{
  assert.ok(Object.isFrozen(command.receiptFields));
  assert.deepEqual(command.receiptFields,['id','revision']);
  await base.apply(tx);return Object.freeze({revision:1,id:t.id});
 }};
 assert.deepEqual(await run(c),{replayed:false,result:{id:t.id,revision:1}});
 assert.deepEqual(fields,['revision','id']);
 assert.deepEqual(await run({...c,receiptFields:Object.freeze(['id','revision']),apply:()=>assert.fail('reapplied')}),{replayed:true,result:{id:t.id,revision:1}});
 const next={...c,key:'fixture-002',expectedRevisions:[{target:t,revision:1}]};
 for(const malformed of [{id:t.id},{id:t.id,revision:1,extra:'no'},{'id,revision':t.id},{id:t.id,revision:1.5}])
  await reject(run({...next,apply:()=>malformed}),'CORE_RECEIPT_INVALID','not_committed');
 assert.equal((await f.counts()).commands,1);
});
