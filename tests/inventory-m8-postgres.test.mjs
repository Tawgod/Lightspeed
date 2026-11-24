import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalTransactionM6} from '../services/lightspeed/localTransactionM6.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
import {planCountObservation,planRestockConfirmation,planReasonRevision} from '../services/lightspeed/inventoryPersistence.js';

const now='2026-11-24T10:30:00.000Z', before='2026-11-24T10:29:00.000Z';
const actor={type:'employee',realm:'employee',id:'E1',tenant:'shop',delegation:{kind:'none'}};
const product={outletId:'01',productId:'0001',variantId:null};
const reason={code:'missing',label:'Missing',revision:1,active:true,requiresNote:false,reviewFlag:'possible_shortage',appliesTo:['zero','partial']};
const locations=[{locationId:'S',outletId:'01',shelfCode:'S',area:'Storage',kind:'storage',active:true,labelDescription:'S'},{locationId:'F',outletId:'01',shelfCode:'F',area:'Floor',kind:'floor',active:true,labelDescription:'F'}];
const line={...product,lineId:'L1',fromLocationId:'S',toLocationId:'F',plannedQuantity:4};
const task=id=>({taskId:id,version:'v1',state:'open',lines:[line]});
const session={sessionId:'C1',state:'open',openedAt:'2026-11-24T10:00:00.000Z',outletId:'01'};
const restock={taskVersion:'v1',batchId:'B1',lines:[{...line,movedQuantity:0,reasonCode:'missing',confirmedAt:before}]};
const count={...product,scanId:'scan1',countMode:'full-outlet',countedQuantity:'3',scannedAt:before};
const target=(type,...ids)=>({type:'inventory.'+type,id:ids.length===1?ids[0]:JSON.stringify(ids)});
const tk=id=>target('task',id), bk=id=>target('batch',id), rk=target('reason','missing'), sk=target('session','C1');
const locs=locations.map(l=>target('location',l.outletId,l.locationId));
const review=id=>target('review',id,'L1');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const effect=(operation,target,fields)=>({operation,target,location:'01',fields});
const row=(e,t)=>e.find(x=>same(x.target,t))?.row;
const make=(f,extra={})=>createLocalTransactionM6({...f,tenant:'shop',authorize:()=>true,authorizeRead:()=>true,authorizeReconcile:()=>true,...extra});
const pg=(name,fn)=>test(name,async()=>withDisposableCorePg(fn));
const reject=(p,code,outcome)=>assert.rejects(p,e=>e.code===code&&(!outcome||e.outcome===outcome));
async function seed(f){
 const records=[[tk('T1'),task('T1')],[tk('T2'),task('T2')],[sk,session],[rk,reason],[target('reason-revision','missing',1),reason],...locs.map((t,i)=>[t,locations[i]])];
 await f.transaction(async tx=>{for(const [t,record] of records){await tx.lockDomain(t);await tx.insertDomain({...t,record});}},{targets:records.map(x=>x[0])});
}
function command(kind,{taskId='T1',key='fixture-001',request,revision=1}={}){
 const p=request??(kind==='restock'?restock:kind==='count'?count:{...reason,revision:2});
 const primary=kind==='restock'?tk(taskId):kind==='count'?sk:rk;
 const output=kind==='restock'?bk(p.batchId):kind==='count'?target('scan','C1',p.scanId):target('reason-revision',p.code,p.revision);
 const existing=kind==='restock'?[primary,rk,...locs]:[primary];
 const absent=kind==='restock'?[output,review(taskId)]:[output];
 const targets=[...existing,...absent];
 const op={restock:'restock.confirm',count:'count.observe',reason:'reason.revise'}[kind];
 const fields={restock:['confirmation'],count:['observation'],reason:['definition']}[kind];
 const effects=targets.map(t=>effect(op,t,fields));
 const plan=(c,e)=>{
  const record=row(e,primary)?.record;
  if(kind==='restock')return planRestockConfirmation({task:record,request:c.payload,locations:locs.map(t=>row(e,t)?.record),reasons:[row(e,rk)?.record],actorId:c.actor.id,recordedAt:now});
  if(kind==='count')return planCountObservation({session:record,request:c.payload,actorId:c.actor.id,recordedAt:now});
  return planReasonRevision({current:record,next:c.payload,actorId:c.actor.id,recordedAt:now});
 };
 const receiptFields=kind==='restock'?['taskId','taskRevision','batchId','outcome']:kind==='count'?['sessionId','scanId','outcome']:['id','revision','outcome'];
 return {scope:'test.inventory.'+kind,key,actor,targets,effects,readEffects:[effect(kind==='reason'?'inventory.reason.read':kind==='count'?'inventory.count.read':'inventory.restock.read',primary,['receipt'])],reconcileEffects:[effect('transactions.reconcile',primary,['receipt'])],payload:p,expectedRevisions:[...existing.map(t=>({target:t,revision:same(t,primary)?revision:1})),...absent.map(t=>({target:t,revision:null}))],receiptFields,
 verifyLocked:({command:c,evidence:e})=>{
  const actual=plan(c,e);
  if(actual.status!=='planned'||c.actor.tenant!=='shop'||c.actor.delegation.kind!=='none'||c.effects.length!==effects.length||!effects.every(x=>c.effects.some(y=>same(x,y))))return false;
  if(kind==='restock')return actual.records.confirmation.taskId===taskId&&actual.records.confirmation.totalInventoryDelta===0&&actual.records.reviews.length===1&&actual.records.confirmation.lines.every(l=>l.outletId==='01');
  return kind==='count'?actual.records.observation.sessionId==='C1':actual.records.reason.code==='missing';
 },
 apply:async(tx,c,e)=>{
  const v=plan(c,e);
  if(kind==='restock'){
   await tx.insertDomain({...output,record:v.records.confirmation});
   await tx.insertDomain({...review(taskId),record:v.records.reviews[0]});
   for(const event of v.records.outbox)await tx.enqueueCanonical({id:JSON.stringify(['inventory.review',taskId,event.reviewId]),record:event});
   const taskRevision=await tx.replaceDomain({...primary,expectedRevision:revision,record:{...row(e,primary).record,state:'closed'}});
   return {taskId,taskRevision,batchId:p.batchId,outcome:'recorded'};
  }
  if(kind==='count'){await tx.insertDomain({...output,record:v.records.observation});return {sessionId:'C1',scanId:p.scanId,outcome:'recorded'};}
  await tx.insertDomain({...output,record:v.records.reason});
  await tx.replaceDomain({...primary,expectedRevision:revision,record:v.records.reason});
  return {id:p.code,revision:p.revision,outcome:'recorded'};
 },projectResult:r=>r};
}
pg('Inventory M8 concurrent replay and tenant-wide batch uniqueness',async f=>{
 await seed(f);const run=make(f), c=command('restock');
 const results=await Promise.all([run(c),run(c)]);assert.equal(results.filter(x=>x.replayed).length,1);
 assert.deepEqual(results[0].result,{taskId:'T1',taskRevision:2,batchId:'B1',outcome:'recorded'});
 await reject(run(command('restock',{taskId:'T2',key:'fixture-002'})),'CORE_REVISION_CONFLICT');
 assert.deepEqual(await f.counts(),{commands:1,domain:0,outbox:1,audit:1});assert.equal((await f.typedCounts()).typed_domain,9);
});
pg('Inventory M8 count and reason append-only identities',async f=>{
 await seed(f);const run=make(f),c=command('count');await run(c);
 await reject(run({...c,key:'fixture-002'}),'CORE_REVISION_CONFLICT');
 const r=command('reason');assert.deepEqual((await run(r)).result,{id:'missing',revision:2,outcome:'recorded'});
 await reject(run({...r,key:'fixture-003'}),'CORE_REVISION_CONFLICT');
 assert.equal((await f.typedCounts()).typed_domain,9);
});
for(const stage of ['afterLocks','beforeCommit'])pg('Inventory M8 rollback on '+stage+' denial',async f=>{
 await seed(f);await reject(make(f,{authorize:x=>x.stage!==stage})(command('restock')),'CORE_FORBIDDEN','not_committed');
 assert.deepEqual(await f.counts(),{commands:0,domain:0,outbox:0,audit:1});assert.equal((await f.typedCounts()).typed_domain,7);
 await make(f)(command('restock'));
});
pg('Inventory M8 wrong actor, tenant, resource and effect cannot replay',async f=>{
 await seed(f);const run=make(f),c=command('restock');await run(c);
 await reject(run({...c,actor:{...actor,id:'E2'}}),'CORE_KEY_CONFLICT');
 await assert.rejects(run({...c,actor:{...actor,tenant:'other'}}),TypeError);
 await reject(run(command('restock',{taskId:'T2'})),'CORE_KEY_CONFLICT');
 await reject(run({...c,effects:c.effects.map(x=>({...x,operation:'inventory.adjust.execute'}))}),'CORE_KEY_CONFLICT');
 await reject(run({...command('count'),effects:command('count').effects.map(x=>({...x,operation:'inventory.adjust.execute'}))}),'CORE_EFFECT_CHANGED');
});
pg('Inventory M8 fresh read and execution authorization on replay',async f=>{
 await seed(f);const c=command('restock');await make(f)(c);
 await reject(make(f,{authorizeRead:()=>false})({...c,apply:()=>assert.fail('reapplied')}),'CORE_FORBIDDEN','committed');
 await reject(make(f,{authorize:()=>false})(c),'CORE_FORBIDDEN');
 assert.equal((await f.counts()).outbox,1);
});
pg('Inventory M8 unknown commit inspection and no blind reexecution',async f=>{
 await seed(f);let applied=0;const base=command('restock');const c={...base,apply:async(...a)=>{applied++;return base.apply(...a);}};
 const transaction=async(...a)=>{await f.transaction(...a);throw Object.assign(Error('lost ack'),{code:'CORE_COMMIT_UNKNOWN'});};
 assert.equal((await make(f,{transaction})(c)).replayed,true);assert.equal(applied,1);
 await reject(make(f,{transaction,authorizeReconcile:()=>false})(c),'CORE_FORBIDDEN','unknown');
 await reject(make(f,{transaction:async()=>{throw Object.assign(Error('unknown'),{code:'CORE_COMMIT_UNKNOWN'});},inspectCommitted:()=>({state:'unknown'})})(c),'CORE_COMMIT_UNKNOWN','unknown');
 assert.equal(applied,1);
});
pg('Inventory M8 atomic review/outbox rollback and immutable audit',async f=>{
 await seed(f);const c=command('restock');await assert.rejects(make(f)({...c,apply:async(...a)=>{await c.apply(...a);throw Error('rollback');}}),/rollback/);
 assert.deepEqual(await f.counts(),{commands:0,domain:0,outbox:0,audit:0});assert.equal((await f.typedCounts()).typed_domain,7);
 await make(f)(c);for(const probe of [f.attemptAuditUpdate,f.attemptAuditDelete,f.attemptAuditTruncate])await assert.rejects(probe(),/immutable/);
});
