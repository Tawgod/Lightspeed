import test from 'node:test';
import assert from 'node:assert/strict';
import {createPurchasingDomainAdapterP12,derivePurchasingIntentP12} from '../services/lightspeed/purchasingAdapterP12.js';
import {withDisposableCorePg} from './fixtures/coreDisposablePg.mjs';
import {fingerprintLightspeedPayload as fp} from '../services/lightspeed/idempotency.js';
const at='2026-11-24T15:00:00.000Z', hash='a'.repeat(64);
function evidence(id='I1'){
 const source={complete:true,readAt:at};
 return {document:{source:{provider:'graph',accountRef:'mail',messageId:'M1',senderKey:'sender@example.test',observedAt:at},attachment:{id:'A1',mime:'application/pdf',byteLength:100,sha256:hash,scanState:'clean',scanRef:'scan'},extraction:{documentHash:hash,kind:'invoice',parserVersion:'fixture',references:[],lines:[{id:'L1',page:1,documentRef:'page1',supplierSku:'001',quantity:'2',unitCost:'3.00',currency:'USD'}]}},
 priorDocuments:[],documentHistoryComplete:true,aliasRows:[{source:'purchasing:graph:mail',alias:'sender@example.test',supplierId:'S1',verified:true,provenance:'alias',observedAt:at}],aliasCoverage:true,
 header:{invoiceId:id,invoiceNumber:'0001',outletId:'O1',supplierId:'S1',reviewRef:'R1',documentHash:hash,poReference:null},
 targets:[{invoiceLineId:'L1',productId:'PR1',variantId:null,reviewRef:'T1',documentHash:hash,identityEvidenceRef:'identity'}],
 linkRows:[{productId:'PR1',variantId:null,supplierId:'S1',supplierSku:'001',primary:true,source:'catalog',provenance:'link',observedAt:at}],linkCoverage:true,
 poList:{items:[],source,scannedCount:0,unresolvedReferenceCount:0},poDetail:null,priorInvoices:[],invoiceHistoryComplete:true,quantityEvidence:{priorLines:[],coverageComplete:true},poVersion:null,historyVersion:'H1',catalogVersion:'C1'};
}


function multi(input){
 const line=input.document.extraction.lines[0];
 input.document.extraction.lines.push({...line,id:'L2',supplierSku:'002',quantity:'3',unitCost:'4.00'});
 input.targets.push({...input.targets[0],invoiceLineId:'L2',productId:'PR2',reviewRef:'T2'});
 input.linkRows.push({...input.linkRows[0],productId:'PR2',supplierSku:'002'});
 const po={id:'P1',reference:'00042',supplier:{id:'S1'},outletId:'O1',poType:'SUPPLIER',purchasingStatus:'OPEN'};
 input.header.poReference='00042';input.document.extraction.references=['00042'];
 input.poList={...input.poList,items:[po],scannedCount:1};
 input.poDetail={...po,source:input.poList.source,lines:[{id:'PL1',productId:'PR1',supplierSku:'001',orderedQty:5},{id:'PL2',productId:'PR2',supplierSku:'002',orderedQty:8}]};
 input.poVersion='P1-v1';
 input.quantityEvidence.priorLines=[{invoiceId:'OLD',invoiceLineId:'OLD1',poId:'P1',poLineId:'PL1',supplierId:'S1',outletId:'O1',invoicedQty:3,state:'verified_current',documentHash:'c'.repeat(64)},{invoiceId:'OLD',invoiceLineId:'OLD2',poId:'P1',poLineId:'PL2',supplierId:'S1',outletId:'O1',invoicedQty:4,state:'verified_current',documentHash:'c'.repeat(64)}];
}

function distinct(input){
 input.header.invoiceNumber='0002';input.document.source.messageId='M2';
 const hash='b'.repeat(64);input.header.documentHash=hash;input.document.attachment.sha256=hash;input.document.extraction.documentHash=hash;
 for(const t of input.targets)t.documentHash=hash;
}
import * as security from '../.security-source/tests/fixtures/hc-secure-s25h-contract.mjs';
function variant(input){
 input.supplierItemCoverage=true;input.variantCoverage=true;
 input.supplierItems=[];input.variantEvidence=[];
 for(let i=0;i<input.targets.length;i++){
  const t=input.targets[i],l=input.poDetail.lines[i],link=input.linkRows[i],prior=input.quantityEvidence.priorLines[i];
  const variantId=i===0?'V001':null,supplierItemId='ITEM'+i;
  Object.assign(t,{variantId,supplierItemId,poLineId:l.id});
  Object.assign(l,{variantId,supplierItemId,revision:'line-v1'});
  Object.assign(link,{variantId});
  input.supplierItems.push({supplierId:'S1',supplierItemId,productId:t.productId,variantId,supplierSku:link.supplierSku,revision:'item-v1',verified:true});
  input.variantEvidence.push({productId:t.productId,variantId,nonvariant:variantId===null,reference:t.identityEvidenceRef,revision:'variant-v1',verified:true});
  Object.assign(prior,{productId:t.productId,variantId,supplierItemId,supplierSku:link.supplierSku});
 }
}
function fixture(f){
 let now=at,deny=()=>false,lose=false,missing=false,epoch='v1',seen=[],revoked=false,reversal=null,inspectionUnknown=false;
 const inputs=new Map([['I1',evidence()],['I2',evidence('I2')]]);for(const input of inputs.values()){multi(input);variant(input);}distinct(inputs.get('I2'));
 const actor={type:'employee',realm:'employee',tenant:'shop',id:'a',delegation:{kind:'none'}};
 const context={actor},read=t=>f.transaction(tx=>tx.lockDomain(t),{targets:[t]});
 const current=(id='I1')=>read({type:'purchasing.invoice',id});
 const ledger=(id='PL1')=>read({type:'purchasing.po.billed-line',id:fp(['S1','O1','P1',id])});
 const history=(id,revision,action)=>read({type:'purchasing.invoice.'+action,id:fp([id,revision])});
 const states=new Map(),originals=new Map();
 const secActor={realm:'employee',id:'a',tenant:'shop',environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null};
 const clock=()=>Date.parse(now);
 const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
 const registry=['purchasing.invoice.review','purchasing.invoice.approve','purchasing.invoice.approval.reverse','purchasing.invoice.credit.review','purchasing.invoice.read','purchasing.invoice.receipt.inspect'].map((operation,i)=>({operation,mode:i<4?'execute':i===4?'read':'inspect',required:['revision','relationships','purpose','audience'],approvalRequired:i<4,assurance:'business'}));
 const evaluator=security.createOfflineAuthorization({registry,readPolicyVersion:()=>epoch,clock,decisionMaxMs:50,readTrustedState:q=>{
  const state=structuredClone(states.get(q.approvalId));
  if(missing)state.admittedScopes.shift();
  if(revoked)state.session.revoked=true;
  return state;
 }});
 const api=createPurchasingDomainAdapterP12({...f,tenant:'shop',security,readPolicyVersion:()=>epoch,resolveEvidenceRef:()=> 'ev1',
  transaction:async(...args)=>{const r=await f.transaction(...args);if(lose)throw Object.assign(Error('lost'),{code:'CORE_COMMIT_UNKNOWN'});return r;},
  inspectCommitted:meta=>inspectionUnknown?{state:'unknown'}:f.inspectCommitted(meta),
  resolveActor:c=>c.actor,readOriginal:(_c,id)=>structuredClone(originals.get(id)),
  readFresh:(_c,id,action)=>({input:structuredClone(inputs.get(id)),reversal:action==='reverse'?structuredClone(reversal):null}),
  decide:async q=>{seen.push(q);if(deny(q))return {allowed:false};return evaluator(q);},clock});
 async function prepare(action,{invoiceId='I1',requestId='r1'}={}){
   const original={actor,invoiceId,requestId,action,at:now,input:structuredClone(inputs.get(invoiceId)),reversal:action==='reverse'?structuredClone(reversal):null,evidenceRef:'ev1'};
   const plan=await derivePurchasingIntentP12({...original,tenant:'shop',readTrustedRow:read});
   const {execution,facts}=plan,proof={reference:'proof-'+fp(execution),executionDigest:fp(execution),reviewerId:'b',expiresAt:clock()+120000};
   originals.set(requestId,structuredClone({...original,rows:plan.rows,approval:proof}));
   const all=[...facts.executionEffects,...facts.readEffects,...facts.inspectEffects];
   const live={active:true,revoked:false,startsAt:0,expiresAt:proof.expiresAt};
   states.set(proof.reference,{evidenceRef:'ev1',policyVersion:epoch,employee:{realm:'employee',id:'a',tenant:'shop',active:true},
    session:{...live,id:'s1',actorId:'a',tenant:'shop',deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false},
    device:{...live,id:'d1',tenant:'shop',kind:'personal',actorId:'a'},site:{...live,id:'site1',tenant:'shop',deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'},
    policy:{tenant:'shop',environment:'test',version:epoch,roles:[{id:'r',active:true,rules:all.map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:live.expiresAt,revoked:false}))}],assignments:[{id:'a',actorId:'a',roleId:'r',startsAt:0,expiresAt:live.expiresAt,revoked:false}],individual:[]},
    approval:{id:proof.reference,scopeDigest:security.executionScopeDigest({actor:secActor,executionDigest:fp(execution),executionEffects:facts.executionEffects}),actorId:'a',tenant:'shop',approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'b',expiresAt:proof.expiresAt},admittedScopes:all});
   return {submit:()=>api.run({context,request:{requestId}}),proof,plan};
 }
 async function approved(){
  await (await prepare('review')).submit();now='2026-11-24T15:01:00.000Z';await (await prepare('approve',{requestId:'a1'})).submit();
  const row=(await current()).record;
  reversal={reference:'rev1',reasonCode:'document-dispute',invoiceId:'I1',supplierId:'S1',outletId:'O1',revision:1,fingerprint:row.revision.fingerprint,approvalRef:row.approval.approvalRef,documentHash:row.evidence.proposal.documentHash,sourceDigest:row.evidence.sourceDigest};
  now='2026-11-24T15:02:00.000Z';
  return row;
 }
 return {api,context,inputs,prepare,current,ledger,history,seen,states,originals,approved,time:v=>now=v,deny:v=>deny=v,lost:v=>lose=v,missing:v=>missing=v,epoch:v=>epoch=v,revoke:v=>revoked=v,reversal:v=>reversal=v,unknown:v=>inspectionUnknown=v};
}
const pg=(name,fn)=>test(name,()=>withDisposableCorePg(f=>fn(f,fixture(f))));
const verified={state:'verified',retryAllowed:false,replayed:false,result:{}},denied={state:'undisclosed',retryAllowed:false},conflict={state:'revision_conflict',retryAllowed:false};
pg('P12 exact variant, supplier item, decimal and replay',async(f,x)=>{
 const a=await x.prepare('review');assert.deepEqual(await a.submit(),verified);
 const line=(await x.current()).record.evidence.proposal.lines[0];assert.equal(line.variantId,'V001');assert.equal(line.supplierSku,'001');assert.equal(line.supplierItemId,'ITEM0');assert.equal(line.receivedQty,null);assert.equal(line.orderedQty,5);assert.equal(line.invoicedQty,2);assert.equal(line.unitCost,'3.00');
 assert.ok(x.seen.some(q=>q.executionEffects.some(e=>e.amount==='3'&&e.currency==='USD'&&e.relationships.some(r=>r.type==='variant'&&r.id==='V001'))));
 assert.deepEqual(await a.submit(),{...verified,replayed:true});assert.equal((await f.counts()).commands,1);
});
pg('P12 exact PO variant and supplier item mismatch fail closed',async(f,x)=>{
 x.inputs.get('I1').poDetail.lines[0].variantId='V002';await assert.rejects(x.prepare('review'),{code:'INVOICE_LINE_CONFLICT'});
 x.inputs.get('I1').poDetail.lines[0].variantId='V001';x.inputs.get('I1').supplierItems[0].supplierSku='1';
 await assert.rejects(x.prepare('review'),{code:'INVOICE_SUPPLIER_ITEM_CONFLICT'});assert.equal((await f.counts()).commands,0);
});
pg('P12 null variant must be independently verified nonvariant',async(f,x)=>{
 x.inputs.get('I1').variantEvidence[1].nonvariant=false;
 await assert.rejects(x.prepare('review'),{code:'INVOICE_VARIANT_UNRESOLVED'});
});
pg('P12 duplicate source and competing cumulative quantity lock',async(f,x)=>{
 const a=await x.prepare('review'),b=await x.prepare('review',{invoiceId:'I2',requestId:'r2'});
 assert.deepEqual(await a.submit(),verified);assert.deepEqual(await b.submit(),conflict);
 await assert.rejects(x.prepare('review',{invoiceId:'I2',requestId:'r3'}),{code:'INVOICE_BILLED_CAPACITY'});
 x.inputs.get('I2').header.invoiceNumber='0001';
 await assert.rejects(x.prepare('review',{invoiceId:'I2',requestId:'r4'}),{code:'INVOICE_DUPLICATE'});
});
pg('P12 correction preserves immutable original approval and source',async(f,x)=>{
 const before=await x.approved(),history=await x.history('I1',1,'approve'),review=await x.history('I1',1,'review');
 x.inputs.get('I1').document.extraction.lines[0].quantity='1';const a=await x.prepare('review',{requestId:'r2'});assert.deepEqual(await a.submit(),verified);
 assert.equal((await x.current()).record.correctionOf.approvalRef,before.approval.approvalRef);assert.deepEqual(await x.history('I1',1,'approve'),history);assert.deepEqual(await x.history('I1',1,'review'),review);
 assert.equal((await x.ledger()).record.reservations[0].quantity,1);
});
pg('P12 reversal distinct grant, original record and retained capacity',async(f,x)=>{
 const before=await x.approved(),history=await x.history('I1',1,'approve'),ledger=await x.ledger();
 const a=await x.prepare('reverse',{requestId:'reverse1'}),state=x.states.get(a.proof.reference);
 const rules=state.policy.roles[0].rules;
 state.policy.roles[0].rules=rules.map(r=>r.effect.operation==='purchasing.invoice.approval.reverse'?{...r,effect:{...r.effect,operation:'purchasing.invoice.credit.review'}}:r);
 assert.deepEqual(await a.submit(),denied);assert.deepEqual(await x.history('I1',1,'approve'),history);
 state.policy.roles[0].rules=rules;assert.deepEqual(await a.submit(),verified);
 assert.equal((await x.current()).record.approval,null);assert.equal((await x.history('I1',1,'reverse')).record.reversal.originalApproval.approvalRef,before.approval.approvalRef);
 assert.deepEqual(await x.ledger(),ledger);assert.deepEqual(await x.history('I1',1,'approve'),history);
 assert.deepEqual(await a.submit(),{...verified,replayed:true});
});
pg('P12 reversal wrong source cannot prepare',async(f,x)=>{
 await x.approved();x.reversal({reference:'rev2',reasonCode:'bad',documentHash:'b'.repeat(64)});
 await assert.rejects(x.prepare('reverse',{requestId:'reverse2'}),{code:'INVOICE_REVERSAL_UNRESOLVED'});
});
for(const [name,setup] of [['incomplete admitted scope',x=>x.missing(true)],['revoked precommit',x=>x.deny(q=>{if(q.stage==='precommit')x.revoke(true);return false;})],['stale policy',x=>x.epoch('v2')],['changed source',x=>x.inputs.get('I1').poDetail.lines[0].revision='line-v2']])pg('P12 '+name+' rolls back',async(f,x)=>{
 const a=await x.prepare('review');setup(x);assert.deepEqual(await a.submit(),denied);assert.equal((await f.counts()).commands,0);
});
pg('P12 unknown commit remains held, no automatic retry',async(f,x)=>{
 const a=await x.prepare('review');x.lost(true);x.unknown(true);
 assert.deepEqual(await a.submit(),{state:'unknown',retryAllowed:false});assert.equal((await f.counts()).commands,1);
 assert.ok(x.seen.some(q=>q.stage==='inspection'&&q.accessEffects.every(e=>e.operation==='purchasing.invoice.receipt.inspect')));
});
pg('P12 independent inspection and postcommit disclosure denial',async(f,x)=>{
 const a=await x.prepare('review');x.lost(true);x.deny(q=>q.stage==='inspection');assert.deepEqual(await a.submit(),denied);assert.equal((await f.counts()).commands,1);
 x.deny(q=>q.stage==='projection');assert.deepEqual(await a.submit(),denied);assert.equal((await f.counts()).commands,1);
});
pg('P12 unknown acknowledgement independently resolves verified original',async(f,x)=>{
 const a=await x.prepare('review');x.lost(true);assert.deepEqual(await a.submit(),{...verified,replayed:true});assert.equal((await f.counts()).commands,1);
});
pg('P12 request cannot supply actor or evidence and changed proof denied',async(f,x)=>{
 const a=await x.prepare('review');assert.deepEqual(await x.api.run({context:x.context,request:{requestId:'r1',actor:'a'}}),denied);
 x.originals.get('r1').approval.reference='replacement';assert.deepEqual(await a.submit(),denied);assert.equal((await f.counts()).commands,0);
});
