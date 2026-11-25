import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRemoteExecutionM7,createRemoteMutationM7} from '../services/lightspeed/remoteMutationM7.js';
import {fingerprintLightspeedPayload as hash} from '../services/lightspeed/idempotency.js';
import {withRemoteM7Pg} from './fixtures/coreRemoteM7Pg.mjs';
const target={productId:'P1',variantId:null};
const effect=(operation,field,t=target,supplierId=null)=>({operation,field,target:t,location:'store',supplierId});
function command(key='request-001',t=target,extra={}){
 const values={sku:'0007',upc:'000123',supplierSku:'0009',cost:'12.00'};
 return prepareRemoteExecutionM7({tenant:'shop',key,actor:{id:'a',realm:'employee',tenant:'shop'},target:t,predecessor:null,values,effects:[effect('catalog.product.create','sku',t),effect('catalog.product.cost.modify','cost',t,'S1')],reservationKeys:[['target',t.productId,t.variantId],['sku',values.sku],['upc',values.upc],['supplierSku','S1',values.supplierSku]],...extra});
}
const request=(execution=command())=>({execution,approval:{reference:'review-1',executionDigest:hash(execution),reviewerId:'b',expiresAt:2000},readEffects:[effect('catalog.product.read','eventId',execution.target)],inspectEffects:[effect('fixture.reconcile','receipt',execution.target)]});
function harness(f,extra={}){
 const events=new Map();let writes=0,lose=false,patch={};
 const engine=createRemoteMutationM7({tenant:'shop',store:f.store,authorizeExecution:()=>true,verifyApproval:({proof})=>proof.expiresAt>1000,authorizeAccess:()=>true,deriveFresh:c=>c,
 dispatch:async({command,digest,eventId})=>{writes++;events.set(eventId,{complete:true,eventId,digest,target:command.target,predecessor:command.predecessor,revision:'v2',values:command.values});if(lose)throw Error('lost acknowledgement');},
 observe:({eventId})=>({...events.get(eventId),...patch}),...extra});
 return {engine,get writes(){return writes;},lose:()=>{lose=true;},patch:p=>{patch=p;}};
}
const pg=(name,fn)=>test(name,()=>withRemoteM7Pg(fn));
pg('M7 remote atomic competing SKU keys and no partial reservation',async f=>{
 const h=harness(f),a=request(),b=request(command('request-002',{productId:'P2',variantId:null}));
 const r=await Promise.all([h.engine.run(a),h.engine.run(b)]);
 assert.deepEqual(r.map(x=>x.state).sort(),['conflict','verified']);assert.equal(h.writes,1);
 assert.equal((await f.counts()).reservations,4);assert.equal((await f.counts()).commands,1);
});
for(const kind of ['upc','supplierSku'])pg('M7 remote competing '+kind+' across distinct targets',async f=>{
 const h=harness(f),a=request(),t={productId:'P2',variantId:null};
 const keys=[['target','P2',null],['sku','0008'],['upc',kind==='upc'?'000123':'000124'],['supplierSku','S1',kind==='supplierSku'?'0009':'0010']];
 const b=request(command('request-002',t,{reservationKeys:keys,values:{sku:'0008',upc:keys[2][1],supplierSku:keys[3][2],cost:'12.00'}}));
 const r=await Promise.all([h.engine.run(a),h.engine.run(b)]);assert.deepEqual(r.map(x=>x.state).sort(),['conflict','verified']);assert.equal(h.writes,1);assert.equal((await f.counts()).reservations,4);
});
pg('M7 remote same-key replay and alternate-key conflict after verification',async f=>{
 const h=harness(f),a=request();await h.engine.run(a);
 assert.equal((await h.engine.run(a)).state,'verified');assert.equal((await h.engine.run(request(command('request-002')))).state,'conflict');assert.equal(h.writes,1);
 await assert.rejects(f.tamper(),/immutable/);
});
pg('M7 remote unknown hold across keys and explicit inspection',async f=>{
 const h=harness(f),a=request();h.lose();assert.equal((await h.engine.run(a)).state,'unknown');
 assert.equal((await h.engine.run(a)).state,'unknown');assert.equal((await h.engine.run(request(command('request-002')))).state,'conflict');
 for(const patch of [{eventId:'other'},{digest:'other'},{predecessor:'other'},{complete:false},{values:{cost:'12'}}]){
 h.patch(patch);assert.equal((await h.engine.reconcile(a)).state,'unknown');}
 h.patch({});assert.equal((await h.engine.reconcile(a)).state,'verified');assert.equal(h.writes,1);
});
pg('M7 remote stale revision and changed effects retain reservation',async f=>{
 const h=harness(f,{deriveFresh:c=>({...c,predecessor:'changed'})});
 assert.equal((await h.engine.run(request())).state,'denied');assert.equal(h.writes,0);
 assert.equal((await h.engine.run(request(command('request-002')))).state,'conflict');
});
pg('M7 remote cost denial and revoked dispatch authority',async f=>{
 const h=harness(f,{authorizeExecution:({effect})=>effect.operation!=='catalog.product.cost.modify'});
 assert.equal((await h.engine.run(request())).state,'denied');assert.equal((await f.counts()).commands,0);
 const n=harness(f,{authorizeExecution:({stage})=>stage!=='dispatch'});
 assert.equal((await n.engine.run(request())).state,'denied');assert.equal(n.writes,0);assert.equal((await f.counts()).commands,1);
});
pg('M7 remote read and inspection independent of execution',async f=>{
 const h=harness(f,{authorizeAccess:({kind})=>kind!=='read'}),a=request();
 assert.equal((await h.engine.run(a)).state,'denied');assert.equal(h.writes,1);
 const n=harness(f,{authorizeAccess:({kind})=>kind!=='inspect'});
 assert.equal((await n.engine.reconcile(a)).state,'denied');
 assert.equal((await n.engine.run(a)).state,'verified');assert.equal(n.writes,0);
});
pg('M7 remote audit failure prevents dispatch',async f=>{
 const h=harness(f,{store:{...f.store,beginDispatch:async()=>{throw Error('audit unavailable');}}});
 assert.equal((await h.engine.run(request())).state,'unknown');assert.equal(h.writes,0);
});
test('M7 remote exact typed identity retains zeros and rejects malformed scope',()=>{
 const c=command();assert.ok(c.reservationKeys.some(k=>k[0]==='sku'&&k[1]==='0007'));
 assert.throws(()=>command('request-002',target,{reservationKeys:[['target','P1',null],['supplierSku','0009']]}),TypeError);
 assert.throws(()=>command('request-002',target,{reservationKeys:[['target','P1',null],['sku',' 0007']]}),TypeError);
});

pg('M7 remote update holds original and changed identity across revision changes',async f=>{
 const a=command('request-001',target,{predecessor:'v1',reservationKeys:[['target','P1',null],['revision','P1',null,'v1'],['sku','0007'],['sku','0008']]});
 const b=command('request-002',target,{predecessor:'v2',reservationKeys:[['target','P1',null],['revision','P1',null,'v2'],['sku','0008'],['sku','0009']]});
 const h=harness(f);h.lose();assert.equal((await h.engine.run(request(a))).state,'unknown');assert.equal((await h.engine.run(request(b))).state,'conflict');assert.equal(h.writes,1);
});
pg('M7 remote different actor and replacement approval cannot retrieve receipt',async f=>{
 const h=harness(f),a=request();await h.engine.run(a);
 const b=request(command('request-001',target,{actor:{id:'other',realm:'employee',tenant:'shop'}}));
 for(const q of [b,{...a,approval:{...a.approval,reference:'other'}}]){
 const r=await h.engine.run(q);assert.ok(['conflict','denied'].includes(r.state));assert.equal(Object.hasOwn(r,'result'),false);}
 assert.equal(h.writes,1);
});
