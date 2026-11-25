import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalTransactionM6} from '../services/lightspeed/localTransactionM6.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
import {planRestockConfirmation,planCountObservation,planReasonRevision} from '../services/lightspeed/inventoryPersistence.js';
const now='2026-11-24T10:30:00.000Z', before='2026-11-24T10:29:00.000Z';
const actor={type:'employee',realm:'employee',id:'E1',tenant:'shop',delegation:{kind:'none'}};
const target=(type,...ids)=>({type:'inventory.'+type,id:ids.length===1?ids[0]:JSON.stringify(ids)});
const key=t=>JSON.stringify([t.type,t.id]);
const same=(a,b)=>key(a)===key(b);
const row=(e,t)=>e.find(x=>same(x.target,t))?.row;
const stable=x=>JSON.stringify(x);
const unique=ts=>[...new Map(ts.map(t=>[key(t),t])).values()];
const loc=(locationId,kind,outletId='01')=>({locationId,kind,outletId,shelfCode:locationId,area:kind,active:true,labelDescription:locationId});
const locations=[loc('S1','storage'),loc('S2','storage'),loc('F1','floor'),loc('F2','floor'),loc('F3','floor','02')];
const lk=l=>target('location',l.outletId,l.locationId);
const reasons=[{code:'missing',label:'Missing',revision:1,active:true,requiresNote:false,reviewFlag:'possible_shortage',appliesTo:['zero','partial']},{code:'extra',label:'Extra',revision:1,active:true,requiresNote:true,reviewFlag:'possible_surplus',appliesTo:['excess']}];
const rk=r=>target('reason',r.code);
const line=(lineId,productId,fromLocationId,toLocationId)=>({lineId,outletId:'01',productId,variantId:null,fromLocationId,toLocationId,plannedQuantity:4});
const lines=[line('L1','0001','S1','F1'),line('L2','0002','S2','F2'),line('L3','0001','S1','F2')];
const task=id=>({taskId:id,version:'v1',state:'open',lines});
const tasks=[task('T1'),task('T2')];
const sessions=['C1','C2'].map(sessionId=>({sessionId,state:'open',outletId:'01',openedAt:'2026-11-24T10:00:00.000Z'}));
const tk=t=>target('task',t.taskId), sk=s=>target('session',s.sessionId);
const req=batchId=>({taskVersion:'v1',batchId,lines:[{...lines[0],movedQuantity:0,reasonCode:'missing',confirmedAt:before},{...lines[1],movedQuantity:5,reasonCode:'extra',note:'fixture private note',confirmedAt:before},{...lines[2],movedQuantity:4,confirmedAt:before}]});
const make=(f,extra={})=>createLocalTransactionM6({...f,tenant:'shop',authorize:()=>true,authorizeRead:()=>true,authorizeReconcile:()=>true,...extra});
const pg=(name,fn)=>test(name,async()=>withDisposableCorePg(fn));
const reject=(p,code,outcome)=>assert.rejects(p,e=>e.code===code&&(!outcome||e.outcome===outcome));
const ef=(operation,target,location,fields)=>({operation,target,location,fields:[...fields].sort()});
const canonicalEffects=xs=>xs.map(x=>stable([x.operation,key(x.target),x.location,[...x.fields].sort()])).sort();
const matching=(a,b)=>stable(canonicalEffects(a))===stable(canonicalEffects(b));
const specs=[...tasks.map(t=>[tk(t),t]),...sessions.map(s=>[sk(s),s]),...locations.map(l=>[lk(l),l]),...reasons.map(r=>[rk(r),r]),...reasons.map(r=>[target('reason-revision',r.code,r.revision),r])];
async function seed(f){await f.transaction(async tx=>{for(const [t,record] of specs){await tx.lockDomain(t);await tx.insertDomain({...t,record});}},{targets:specs.map(x=>x[0])});}
async function inspect(f,t){return f.transaction(tx=>tx.lockDomain(t),{targets:[t]});}
async function change(f,t,record){return f.transaction(async tx=>{const r=await tx.lockDomain(t);return tx.replaceDomain({...t,expectedRevision:r.revision,record});},{targets:[t]});}
// Test-only trusted fixture builder, not a public endpoint or grant derivation from browser data.
function restock(t=tasks[0],p=req('B1'),commandKey='fixture-001'){
 const primary=tk(t), batch=target('batch',p.batchId);
 const derive=(trusted,request,ls,rs)=>{
  const neededLoc=unique(trusted.lines.flatMap(l=>[target('location',l.outletId,l.fromLocationId),target('location',l.outletId,l.toLocationId)]));
  const neededReason=unique(request.lines.filter(l=>l.reasonCode!=null).map(l=>target('reason',l.reasonCode)));
  const plan=planRestockConfirmation({task:trusted,request,locations:ls,reasons:rs,actorId:actor.id,recordedAt:now});
  if(plan.status!=='planned')return null;
  const reviews=plan.records.reviews.map(r=>target('review',trusted.taskId,r.lineId));
  const products=unique(trusted.lines.map(l=>target('product',l.outletId,l.productId,l.variantId)));
  const targets=unique([primary,batch,...neededLoc,...neededReason,...reviews,...products]);
  const effects=[ef('restock.confirm',primary,'01',['confirmation']),ef('restock.confirm',batch,'01',['confirmation']),...neededLoc.map(x=>ef('restock.confirm',x,'01',['movement'])),...neededReason.map(x=>ef('restock.confirm',x,'01',['reason'])),...reviews.map(x=>ef('restock.confirm',x,'01',['review'])),...products.map(x=>ef('restock.confirm',x,'01',['movement']))];
  return {plan,targets,effects,neededLoc,neededReason,reviews,products};
 };
 const d=derive(t,p,locations,reasons);
 if(!d)throw Error('Invalid fixture input');
 const existing=[primary,...d.neededLoc,...d.neededReason];
 const verify=(c,e)=>{
  const trusted=row(e,primary)?.record;
  if(!trusted||c.actor.id!==actor.id||c.actor.tenant!==actor.tenant||c.actor.delegation.kind!=='none')return null;
  const v=derive(trusted,c.payload,d.neededLoc.map(x=>row(e,x)?.record),d.neededReason.map(x=>row(e,x)?.record));
  if(!v||!matching(v.effects,c.effects)||stable(v.targets.map(key).sort())!==stable(c.targets.map(key).sort()))return null;
  if(v.plan.records.confirmation.totalInventoryDelta!==0)return null;
  return v;
 };
 return {scope:'test.inventory.restock',key:commandKey,actor,targets:d.targets,effects:d.effects,readEffects:[ef('inventory.restock.read',primary,'01',['receipt'])],reconcileEffects:[ef('transactions.reconcile',primary,'01',['receipt'])],payload:p,expectedRevisions:d.targets.map(target=>({target,revision:existing.some(x=>same(x,target))?1:null})),receiptFields:['taskId','taskRevision','batchId','outcome'],
 verifyLocked:({command:c,evidence:e})=>!!verify(c,e),
 apply:async(tx,c,e)=>{
  const v=verify(c,e);assert.ok(v);const records=v.plan.records;
  await tx.insertDomain({...batch,record:records.confirmation});
  for(const r of records.reviews)await tx.insertDomain({...target('review',t.taskId,r.lineId),record:r});
  for(const event of records.outbox)await tx.enqueueCanonical({id:JSON.stringify(['inventory.review',t.taskId,event.reviewId]),record:event});
  const taskRevision=await tx.replaceDomain({...primary,expectedRevision:1,record:{...row(e,primary).record,state:'closed'}});
  return {taskId:t.taskId,taskRevision,batchId:p.batchId,outcome:'recorded'};
 },projectResult:r=>({taskId:r.taskId,batchId:r.batchId,outcome:r.outcome})};
}
function count(s,scanId,locationId='F1',commandKey='fixture-001'){
 const primary=sk(s), output=target('scan',s.sessionId,scanId), location=target('location',s.outletId,locationId), product=target('product',s.outletId,'0001',null);
 const payload={outletId:s.outletId,productId:'0001',variantId:null,scanId,countMode:'shelf',locationId,countedQuantity:'3',scannedAt:before};
 const targets=[primary,output,location,product],effects=targets.map(t=>ef('count.observe',t,s.outletId,['observation']));
 const derive=(c,e)=>{const l=row(e,location)?.record,session=row(e,primary)?.record;if(!l?.active||l.outletId!==session?.outletId||l.locationId!==c.payload.locationId||!matching(effects,c.effects)||c.actor.id!==actor.id)return null;const v=planCountObservation({session,request:c.payload,actorId:c.actor.id,recordedAt:now});return v.status==='planned'?v:null;};
 return {scope:'test.inventory.count',key:commandKey,actor,targets,effects,readEffects:[ef('inventory.count.read',primary,s.outletId,['receipt'])],reconcileEffects:[ef('transactions.reconcile',primary,s.outletId,['receipt'])],payload,expectedRevisions:targets.map(target=>({target,revision:same(target,primary)||same(target,location)?1:null})),receiptFields:['sessionId','scanId','outcome'],verifyLocked:({command,evidence})=>!!derive(command,evidence),apply:async(tx,c,e)=>{const v=derive(c,e);assert.ok(v);await tx.insertDomain({...output,record:v.records.observation});return {sessionId:s.sessionId,scanId,outcome:'recorded'};},projectResult:r=>({sessionId:r.sessionId,scanId:r.scanId,outcome:r.outcome})};
}
pg('M9 three-line confirmation records two reviews and zero stock effects',async f=>{
 await seed(f);const c=restock(),result=await make(f)(c);assert.deepEqual(result.result,{taskId:'T1',batchId:'B1',outcome:'recorded'});
 const r=(await inspect(f,target('batch','B1'))).record;assert.equal(r.lines.length,3);assert.equal(r.totalInventoryDelta,0);assert.deepEqual(r.lines.map(x=>x.movedQuantity),[0,5,4]);assert.equal(r.lines[1].note,'fixture private note');assert.equal(r.lines[0].reason.revision,1);
 for(const id of ['L1','L2'])assert.equal((await inspect(f,target('review','T1',id))).record.quantityVariance,null);
 assert.equal((await f.counts()).outbox,2);assert.equal((await inspect(f,tk(tasks[0]))).record.state,'closed');
});
pg('M9 competing tasks race for same tenant batch; exactly one commits',async f=>{
 await seed(f);const run=make(f);const results=await Promise.allSettled([run(restock(tasks[0],req('B1'),'fixture-001')),run(restock(tasks[1],req('B1'),'fixture-002'))]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'CORE_REVISION_CONFLICT');
 assert.equal((await f.counts()).commands,1);assert.equal((await f.counts()).outbox,2);
 const states=await Promise.all(tasks.map(async t=>(await inspect(f,tk(t))).record.state));assert.deepEqual(states.sort(),['closed','open']);
});
pg('M9 same task competing batches and same-key replay',async f=>{
 await seed(f);const run=make(f),a=restock(),b=restock(tasks[0],req('B2'),'fixture-002');
 const results=await Promise.allSettled([run(a),run(a),run(b)]);
 const ok=results.filter(x=>x.status==='fulfilled');assert.ok(ok.length===1||ok.length===2);assert.equal(ok.filter(x=>!x.value.replayed).length,1);
 assert.equal((await f.counts()).commands,1);assert.equal((await f.counts()).outbox,2);
});
for(const [label,t,record] of [['task',tk(tasks[0]),{...tasks[0],version:'v2'}],['location',lk(locations[0]),{...locations[0],active:false}],['reason',rk(reasons[0]),{...reasons[0],revision:2,active:false}]])pg('M9 stale '+label+' revision blocks full confirmation',async f=>{
 await seed(f);const c=restock();await change(f,t,record);await reject(make(f)(c),'CORE_REVISION_CONFLICT');assert.equal((await f.counts()).commands,0);assert.equal((await f.counts()).outbox,0);
});
pg('M9 multi-line rollback after writes and precommit denial preserve all records',async f=>{
 await seed(f);const c=restock();
 await assert.rejects(make(f)({...c,apply:async(...args)=>{await c.apply(...args);throw Error('rollback');}}),/rollback/);
 await reject(make(f,{authorize:x=>x.stage!=='beforeCommit'})(c),'CORE_FORBIDDEN','not_committed');
 assert.equal((await f.typedCounts()).typed_domain,specs.length);assert.equal((await f.counts()).commands,0);assert.equal((await f.counts()).outbox,0);
 assert.equal((await inspect(f,tk(tasks[0]))).record.state,'open');await make(f)(c);
});
pg('M9 independent sessions and scan identities; stale and wrong location deny',async f=>{
 await seed(f);const run=make(f);const a=count(sessions[0],'scan1','F1','fixture-001'),b=count(sessions[1],'scan1','F2','fixture-002');await Promise.all([run(a),run(b)]);
 await reject(run({...a,key:'fixture-003'}),'CORE_REVISION_CONFLICT');
 const stale=count(sessions[0],'scan2','F1','fixture-004');await change(f,sk(sessions[0]),{...sessions[0],state:'closed'});await reject(run(stale),'CORE_REVISION_CONFLICT');
 const wrong=count(sessions[1],'scan2','F3','fixture-005');await reject(run(wrong),'CORE_REVISION_CONFLICT');
 assert.equal((await f.counts()).commands,2);
});
pg('M9 exact product and shelf effect denial; independent read projection',async f=>{
 await seed(f);const c=restock();
 await reject(make(f,{authorize:x=>!(x.effect.target.type==='inventory.product'&&x.effect.target.id.includes('0002'))})(c),'CORE_FORBIDDEN');
 await reject(make(f)({...c,effects:c.effects.filter(x=>x.target.type!=='inventory.location')}),'CORE_EFFECT_CHANGED');
 await make(f)(c);await reject(make(f,{authorizeRead:()=>false})(c),'CORE_FORBIDDEN','committed');
 const r=await make(f)({...c,apply:()=>assert.fail('reapplied')});assert.equal(r.replayed,true);assert.deepEqual(Object.keys(r.result).sort(),['batchId','outcome','taskId']);assert.equal((await f.counts()).outbox,2);
});
pg('M9 historical reason and batch evidence survive later reason revision',async f=>{
 await seed(f);await make(f)(restock());const old=await inspect(f,target('batch','B1'));
 const next={...reasons[0],revision:2,label:'Updated'},hist=target('reason-revision','missing',2),primary=rk(reasons[0]),targets=[primary,hist];
 const cmd={scope:'test.inventory.reason',key:'fixture-002',actor,targets,effects:targets.map(t=>ef('reason.revise',t,'01',['definition'])),readEffects:[ef('inventory.reason.read',primary,'01',['receipt'])],reconcileEffects:[ef('transactions.reconcile',primary,'01',['receipt'])],payload:next,expectedRevisions:[{target:primary,revision:1},{target:hist,revision:null}],receiptFields:['id','revision','outcome'],verifyLocked:({command,evidence})=>planReasonRevision({current:row(evidence,primary).record,next:command.payload,actorId:actor.id,recordedAt:now}).status==='planned',apply:async(tx,c,e)=>{const v=planReasonRevision({current:row(e,primary).record,next:c.payload,actorId:actor.id,recordedAt:now});await tx.insertDomain({...hist,record:v.records.reason});await tx.replaceDomain({...primary,expectedRevision:1,record:v.records.reason});return {id:'missing',revision:2,outcome:'recorded'};},projectResult:r=>r};
 await make(f)(cmd);assert.deepEqual(await inspect(f,target('batch','B1')),old);assert.equal((await inspect(f,target('reason-revision','missing',1))).record.label,'Missing');assert.equal((await inspect(f,hist)).record.label,'Updated');
 for(const probe of [f.attemptAuditUpdate,f.attemptAuditDelete,f.attemptAuditTruncate])await assert.rejects(probe(),/immutable/);
});
