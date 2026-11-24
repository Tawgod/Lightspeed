import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyntheticPurchaseOrderMutation} from '../services/lightspeed/syntheticPurchaseOrderMutation.js';
import {createLightspeedAudit} from '../services/lightspeed/audit.js';
import {createLightspeedIdempotency} from '../services/lightspeed/idempotency.js';
import {prepareInvoiceProposal} from '../services/lightspeed/invoiceReconciliation.js';
import {prepareInvoiceReviewRevision} from '../services/lightspeed/invoiceReviewContract.js';
const copy=x=>JSON.parse(JSON.stringify(x));
function setup({create=false,allow=true,duplicate=false,auditFail=false,damage=false,uncertain=false}={}){
 const source={complete:true,readAt:'2026-11-24T15:00:00.000Z'};
 const po={id:'P1',reference:'REF',supplier:{id:'S1'},outletId:'O1',poType:'SUPPLIER',purchasingStatus:'OPEN'};
 const line={id:'L1',supplierSku:'001',invoicedQty:2,unitCost:'3.00',currency:'USD',documentRef:'D'};
 const invoice={id:'I1',kind:'invoice',supplierId:'S1',outletId:'O1',invoiceNumber:'0001',documentHash:'a'.repeat(64),poReference:create?null:'REF',lines:[line]};
 const reconciliation={invoice,poList:{source,items:create?[]:[po],scannedCount:create?0:1,unresolvedReferenceCount:0},priorInvoices:[],historyComplete:true,poDetail:create?null:{...po,source,lines:[{id:'PL1',productId:'PR1',supplierSku:'001',orderedQty:5}]},catalogMatches:[{invoiceLineId:'L1',state:'verified',productId:'PR1',supplierId:'S1',supplierSku:'001',relationship:'existing',evidenceRef:'C'}]};
 const proposal=prepareInvoiceProposal(reconciliation);
 const evidence={proposal,quantityEvidence:{priorLines:[],coverageComplete:true},poVersion:create?null:'V1',historyVersion:'H1',catalogVersion:'C1'};
 const revision=prepareInvoiceReviewRevision({...evidence,expectedRevision:0,reviewRef:'R',recordedAt:source.readAt});
 const approval={invoiceId:'I1',revision:1,fingerprint:revision.fingerprint,approvalRef:'A',recordedAt:'2026-11-24T15:01:00.000Z'};
 const before={id:'P1',type:'SUPPLIER',status:'OPEN',supplierId:'S1',outletId:'O1',invoiceId:null,lines:[{id:'PL1',productId:'PR1',supplierSku:'001',orderedQty:5,receivedQty:0,unitCost:'2.00',currency:'USD'}]};
 const state={revision,approval,evidence,reconciliation,expectedBefore:create?null:copy(before),executionState:'review_ready'};
 let snapshot=create?null:copy(before),writes=0,unknown=0,tail=Promise.resolve();const events=[],claims=new Map(),commands=[];
 const fixture={kind:'synthetic-only',withExclusiveInvoiceScope:(_id,fn)=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;},loadReview:async()=>copy(state),readPO:async()=>copy(snapshot),assertNoDuplicate:async()=>!duplicate,
 createOpen:async c=>{writes++;commands.push(copy(c));snapshot={id:'NEW',type:c.type,status:c.status,supplierId:c.supplierId,outletId:c.outletId,invoiceId:c.invoiceId,lines:c.lines.map((l,i)=>({id:'NEW'+i,productId:l.productId,supplierSku:l.supplierSku,orderedQty:l.orderedQty,receivedQty:damage?1:0,unitCost:l.unitCost,currency:l.currency}))};if(uncertain)throw Error('lost response');return {id:'NEW'};},
 updateOpen:async c=>{writes++;commands.push(copy(c));snapshot.lines[0].unitCost=c.lines[0].unitCost;if(damage)snapshot.lines[0].receivedQty=1;if(uncertain)throw Error('lost response');return {id:'P1'};},
 recordVerified:async ({reviewFingerprint})=>{state.executionState='verified';state.verifiedFingerprint=reviewFingerprint;return true;},recordUnknown:async()=>{unknown++;state.executionState='unknown';return true;}};
 const store={claim:async ({scope,key,fingerprint})=>{const k=scope+key,r=claims.get(k);if(r)return r.fingerprint!==fingerprint?{state:'conflict'}:r.state==='replay'?r:{state:'pending'};claims.set(k,{state:'pending',fingerprint});return {state:'claimed',lease:'lease'};},complete:async({scope,key,fingerprint,result})=>claims.set(scope+key,{state:'replay',fingerprint,result,verified:true}),markUnknown:async({scope,key,fingerprint})=>claims.set(scope+key,{state:'unknown',fingerprint})};
 const config={enabled:true,fixture,policy:{authorize:async()=>{if(!allow)throw Error('denied');return {identityType:'employee',identityId:'fixture-actor'};}},audit:createLightspeedAudit({append:async e=>{if(auditFail)throw Error('audit down');events.push(e);return {id:'audit'+events.length};}}),idempotency:createLightspeedIdempotency({store}),clock:()=>new Date('2026-11-24T15:02:00.000Z')};
 const run=()=>createSyntheticPurchaseOrderMutation(config).run({invoiceId:'I1',principal:{},correlationId:'trace'});
 return {config,state,run,events,claims,commands,writes:()=>writes,unknown:()=>unknown,snapshot:()=>snapshot};
}
test('default disabled and wrong fixture kind refuse construction',()=>{assert.throws(()=>createSyntheticPurchaseOrderMutation(),{code:'PO_SYNTHETIC_DISABLED'});assert.throws(()=>createSyntheticPurchaseOrderMutation({enabled:true,fixture:{kind:'production'}}),{code:'PO_SYNTHETIC_DISABLED'});});
test('synthetic create OPEN only, quantities ordered not received, audit and readback',async()=>{const f=setup({create:true});const r=await f.run();assert.equal(r.state,'synthetic_verified');assert.equal(r.productionExecutable,false);assert.equal(f.snapshot().status,'OPEN');assert.equal(f.snapshot().lines[0].receivedQty,0);assert.equal(f.snapshot().lines[0].orderedQty,2);assert.deepEqual(f.events.map(e=>e.stage),['requested','verified']);assert.equal(Object.hasOwn(f.commands[0].lines[0],'receivedQty'),false);});
test('update cost only, preserves ordered and received quantities',async()=>{const f=setup();await f.run();assert.equal(f.snapshot().lines[0].unitCost,'3.00');assert.equal(f.snapshot().lines[0].orderedQty,5);assert.equal(f.snapshot().lines[0].receivedQty,0);});
test('serialized duplicate requests replay once',async()=>{const f=setup();const r=await Promise.all([f.run(),f.run()]);assert.equal(f.writes(),1);assert.equal(r[1].replayed,true);});
test('denied policy and unavailable audit prevent write',async()=>{for(const opts of [{allow:false},{auditFail:true}]){const f=setup(opts);await assert.rejects(f.run());assert.equal(f.writes(),0);}});
test('changed approval and changed reconciliation block before mutation',async()=>{const a=setup();a.state.approval.fingerprint='b'.repeat(64);await assert.rejects(a.run(),{code:'PO_APPROVAL_STALE'});const b=setup();b.state.reconciliation.invoice.lines[0].unitCost='4.00';await assert.rejects(b.run(),{code:'PO_RECONCILIATION_CHANGED'});assert.equal(a.writes()+b.writes(),0);});
test('duplicate guard and changed snapshot block write',async()=>{const a=setup({duplicate:true});await assert.rejects(a.run());assert.equal(a.writes(),0);const b=setup();b.state.expectedBefore.lines[0].unitCost='1.00';await assert.rejects(b.run());assert.equal(b.writes(),0);});
test('readback receipt mismatch quarantines without retry',async()=>{const f=setup({damage:true});await assert.rejects(f.run());assert.equal(f.unknown(),1);await assert.rejects(f.run(),{code:'PO_EXECUTION_STATE_BLOCKED'});assert.equal(f.writes(),1);});
test('lost response quarantines without retry',async()=>{const f=setup({create:true,uncertain:true});await assert.rejects(f.run());assert.equal(f.unknown(),1);await assert.rejects(f.run());assert.equal(f.writes(),1);});
test('verified execution cannot be replaced by another revision',async()=>{const f=setup();await f.run();f.state.verifiedFingerprint='c'.repeat(64);await assert.rejects(f.run(),{code:'PO_VERIFIED_REVISION_CONFLICT'});assert.equal(f.writes(),1);});
