import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCatalogMutation,inspectCatalogMutationApproval,inspectCatalogReadback} from '../services/lightspeed/productCatalogMutationCandidate.js';
import {createAuditedLightspeedMutation} from '../services/lightspeed/mutations.js';
import {createLightspeedAudit} from '../services/lightspeed/audit.js';
import {createLightspeedIdempotency} from '../services/lightspeed/idempotency.js';

// Entire composition is an offline fixture, not a vendor or runtime adapter.
// No imported HTTP client, persistence engine, routes, or external effects.
const target={productId:'000P',variantId:null};
const ev={source:'fixture',provenance:'row'};
const now=1000;
function fixture(desired={cost:'13.00'},create=false){
 const t=create?{productId:'000Q',variantId:null}:target;
 const snapshot={complete:true,version:'v1',products:[{...target,active:true,values:{name:'Old',sku:'0007',cost:'12.00'}}],
 identity:[{...target,active:true,identifiers:[{kind:'SKU',exactValue:'0007',...ev}]}],links:[],identityComplete:true,linksComplete:true,
 references:Object.fromEntries(['suppliers','brands','manufacturers','departments','categories','tags'].map(k=>[k,[]])),referencesComplete:true};
 const request={requestId:'req-m8-01',target:t,desired,expectedVersion:'v1'};
 const proposal=prepareCatalogMutation({request,snapshot});
 assert.equal(proposal.state,'review_required');
 const approval={reviewRef:'fixture-review',fingerprint:proposal.fingerprint,actorId:'employee-a',expiresAt:2000};
 return {snapshot,request,proposal,approval};
}
function harness(f){
 const records=new Map(),events=[],decisions=[];
 let writes=0,observation=null,deny=null,lose=false,stale=false,badReadback=false,failAudit=false,denyAtDispatch=false;
 // Minimal in-memory model of Core's existing store contract; NOT durability evidence.
 const store={
  async claim({scope,key,fingerprint}){
   const k=scope+'|'+key, r=records.get(k);
   if(r){if(r.fingerprint!==fingerprint)return {state:'conflict'};
    return r.state==='verified'?{state:'replay',verified:true,fingerprint,result:r.result}:{state:'unknown'};}
   records.set(k,{state:'claimed',fingerprint,lease:k});return {state:'claimed',lease:k};
  },
  async complete({lease,result,fingerprint}){records.set(lease,{state:'verified',fingerprint,result});},
  async markUnknown({lease}){records.get(lease).state='unknown';}
 };
 const audit=createLightspeedAudit({append:async event=>{if(failAudit)throw Error('fixture audit unavailable');events.push(event);return {id:events.length};}});
 const core=createAuditedLightspeedMutation({tenant:'catalog-fixture',environment:'test',audit,idempotency:createLightspeedIdempotency({store}),
 policy:{authorize:async ({principal})=>({identityType:'employee',identityId:principal})}});
 const authorize=async ({operation,context})=>{decisions.push({operation,actor:context.actorId});return operation!==deny;};
 async function checks(actorId,approval,clock){
  if(approval.actorId!==actorId||!Number.isFinite(approval.expiresAt)||clock>=approval.expiresAt)throw Error('approval actor or expiry');
  const p=prepareCatalogMutation({request:f.request,snapshot:f.snapshot});
  if(p.fingerprint!==f.proposal.fingerprint)throw Error('original evidence changed');
  const checked=await inspectCatalogMutationApproval({proposal:p,approval,authorize,context:{actorId}});
  if(checked.state!=='fixture_checks_passed')throw Error('effect denied');
  return p;
 }
 async function run({actorId='employee-a',approval=f.approval,clock=now}={}){
  const p=await checks(actorId,approval,clock);
  const payload={actorId,approval:{...approval},plan:p.plan,fingerprint:p.fingerprint};
  return core.run({principal:actorId,operation:'catalog.product.'+p.plan.effect,correlationId:'fixture-correlation',
   key:'fixture-request-01',entityType:'product',entityId:p.plan.target.productId,payload,
   execute:async approved=>{
    if(denyAtDispatch)deny='catalog.product.'+p.plan.effect+'.execute';
    await checks(actorId,approval,clock);
    const fresh=prepareCatalogMutation({request:f.request,snapshot:stale?{...f.snapshot,version:'v2'}:f.snapshot});
    if(fresh.fingerprint!==approved.fingerprint)throw Error('stale or changed');
    // Synthetic vendor event only. Receipt is minimal and bound to this fixture event.
    writes++;
    const receipt={eventId:'fixture-event-'+writes,fingerprint:approved.fingerprint};
    observation={...p.plan.target,complete:true,fingerprint:approved.fingerprint,version:'v2',values:{...p.plan.after},eventId:receipt.eventId};
    if(lose)throw Error('fixture lost acknowledgement');
    return receipt;
   },
   verifyReadback:async receipt=>!badReadback&&observation?.eventId===receipt.eventId&&
    inspectCatalogReadback({proposal:p,observation}).state==='verified_evidence'
  });
 }
 return {run,events,decisions,records,get writes(){return writes;},
  deny:v=>{deny=v;},lose:()=>{lose=true;},stale:()=>{stale=true;},badReadback:()=>{badReadback=true;},
  failAudit:()=>{failAudit=true;},denyAtDispatch:()=>{denyAtDispatch=true;}};
}
test('M8 fixture update requires cost grant, exact readback, minimal receipt and audit',async()=>{
 const h=harness(fixture());const r=await h.run();
 assert.equal(h.writes,1);assert.equal(r.replayed,false);
 assert.deepEqual(Object.keys(r.result).sort(),['eventId','fingerprint']);
 assert.ok(h.decisions.some(d=>d.operation==='catalog.product.cost.modify'));
 assert.deepEqual(h.events.map(e=>e.stage),['requested','verified']);
 assert.ok(h.events.every(e=>e.actorId==='employee-a'&&!Object.hasOwn(e,'cost')));
});
test('M8 fixture creation and same-key verified replay do not duplicate dispatch',async()=>{
 const h=harness(fixture({name:'New',sku:'0008'},true));
 await h.run();const replay=await h.run();assert.equal(replay.replayed,true);assert.equal(h.writes,1);
 assert.ok(h.decisions.some(d=>d.operation==='catalog.product.create.execute'));
});
test('M8 fixture denies missing cost effect before audit or dispatch',async()=>{
 const h=harness(fixture());h.deny('catalog.product.cost.modify');
 await assert.rejects(h.run(),/effect denied/);assert.equal(h.writes,0);assert.equal(h.events.length,0);
});
test('M8 fixture binds approval to actor and expiry; different approved actor cannot replay same key',async()=>{
 const f=fixture(),h=harness(f);await h.run();
 await assert.rejects(h.run({actorId:'employee-b'}),/approval actor/);
 await assert.rejects(h.run({clock:2000}),/approval actor/);
 await assert.rejects(h.run({actorId:'employee-b',approval:{...f.approval,actorId:'employee-b'}}),{code:'LIGHTSPEED_KEY_CONFLICT'});
 assert.equal(h.writes,1);
});
test('M8 fixture rechecks current grants before replay and dispatch',async()=>{
 const h=harness(fixture());await h.run();h.deny('catalog.product.update.execute');
 await assert.rejects(h.run(),/effect denied/);assert.equal(h.writes,1);
 const h2=harness(fixture());h2.denyAtDispatch();await assert.rejects(h2.run(),{code:'LIGHTSPEED_MUTATION_UNKNOWN'});assert.equal(h2.writes,0);
});
test('M8 fixture fresh revision blocks dispatch, and audit failure blocks claim',async()=>{
 const h=harness(fixture());h.stale();await assert.rejects(h.run(),{code:'LIGHTSPEED_MUTATION_UNKNOWN'});assert.equal(h.writes,0);
 const h2=harness(fixture());h2.failAudit();await assert.rejects(h2.run(),{code:'LIGHTSPEED_AUDIT_UNAVAILABLE'});assert.equal(h2.records.size,0);assert.equal(h2.writes,0);
});
test('M8 fixture lost acknowledgement or incomplete readback cannot automatically retry',async()=>{
 for(const failure of ['lose','badReadback']){
  const h=harness(fixture());h[failure]();await assert.rejects(h.run(),{code:'LIGHTSPEED_MUTATION_UNKNOWN'});
  await assert.rejects(h.run(),{code:'LIGHTSPEED_MUTATION_UNKNOWN'});assert.equal(h.writes,1);
  assert.ok(h.events.some(e=>e.stage==='unknown'));
 }
});
test('M8 fixture rejects modified approval fingerprint or original evidence',async()=>{
 const f=fixture(),h=harness(f);
 await assert.rejects(h.run({approval:{...f.approval,fingerprint:'a'.repeat(64)}}),/effect denied/);
 f.request.desired.cost='14.00';await assert.rejects(h.run(),/original evidence changed/);assert.equal(h.writes,0);
});
