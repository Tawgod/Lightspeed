import test from 'node:test';
import assert from 'node:assert/strict';
import {createInvoicePersistenceM8} from '../services/lightspeed/invoicePersistenceM8.js';
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
function fixture(f){
 let now=at,deny=()=>false,lose=false,missing=false,epoch='v1',seen=[],approvalChanged=false;
 const inputs=new Map([['I1',evidence()],['I2',evidence('I2')]]);for(const input of inputs.values())multi(input);distinct(inputs.get('I2'));
 const context={actor:{type:'employee',realm:'employee',tenant:'shop',id:'a',delegation:{kind:'none'}}};
 const read=t=>f.transaction(tx=>tx.lockDomain(t),{targets:[t]});
 const current=(id='I1')=>read({type:'purchasing.invoice',id});
 const ledger=(id='PL1')=>read({type:'purchasing.po.billed-line',id:fp(['S1','O1','P1',id])});
 const history=(id,revision,action)=>read({type:'purchasing.invoice.'+action,id:fp([id,revision])});
 const states=new Map();
 const actor={realm:'employee',id:'a',tenant:'shop',environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null};
 const clock=()=>Date.parse(now);
 const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
 const registry=['purchasing.invoice.review','purchasing.invoice.approve','purchasing.invoice.read','purchasing.invoice.receipt.inspect'].map((operation,i)=>({operation,mode:i<2?'execute':i===2?'read':'inspect',required:['revision','relationships','purpose','audience'],approvalRequired:i<2,assurance:'business'}));
 const evaluator=security.createOfflineAuthorization({registry,readPolicyVersion:()=>epoch,clock,decisionMaxMs:50,readTrustedState:q=>{
  const state=structuredClone(states.get(q.approvalId));
  if(missing)state.admittedScopes.shift();
  if(approvalChanged)state.approval.id='replacement';
  return state;
 }});
 const api=createInvoicePersistenceM8({...f,tenant:'shop',security,readPolicyVersion:()=>epoch,resolveEvidenceRef:()=> 'ev1',
  transaction:async(...args)=>{const r=await f.transaction(...args);if(lose)throw Object.assign(Error('lost'),{code:'CORE_COMMIT_UNKNOWN'});return r;},
  resolveActor:c=>c.actor,loadEvidence:id=>structuredClone(inputs.get(id)),readTrustedRow:read,
  issueProof:({execution,facts})=>{
   const proof={reference:'proof-'+fp(execution),executionDigest:fp(execution),reviewerId:'b',expiresAt:clock()+120000};
   const all=[...facts.executionEffects,...facts.readEffects,...facts.inspectEffects];
   const live={active:true,revoked:false,startsAt:0,expiresAt:proof.expiresAt};
   states.set(proof.reference,{evidenceRef:'ev1',policyVersion:epoch,employee:{realm:'employee',id:'a',tenant:'shop',active:true},
    session:{...live,id:'s1',actorId:'a',tenant:'shop',deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false},
    device:{...live,id:'d1',tenant:'shop',kind:'personal',actorId:'a'},site:{...live,id:'site1',tenant:'shop',deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'},
    policy:{tenant:'shop',environment:'test',version:epoch,roles:[{id:'r',active:true,rules:all.map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:live.expiresAt,revoked:false}))}],assignments:[{id:'a',actorId:'a',roleId:'r',startsAt:0,expiresAt:live.expiresAt,revoked:false}],individual:[]},
    approval:{id:proof.reference,scopeDigest:security.executionScopeDigest({actor,executionDigest:fp(execution),executionEffects:facts.executionEffects}),actorId:'a',tenant:'shop',approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'b',expiresAt:proof.expiresAt},admittedScopes:all});
   return proof;
  },decide:async q=>{seen.push(q);if(deny(q))return {allowed:false};return evaluator(q);},clock:()=>new Date(now)});
 const prepare=(action,extra={})=>api.prepare({context,invoiceId:'I1',requestId:'review-1',action,...extra});
 return {inputs,prepare,current,ledger,history,seen,time:v=>now=v,deny:v=>deny=v,lost:v=>lose=v,missing:v=>missing=v,changed:v=>approvalChanged=v,epoch:v=>epoch=v};
}
const pg=(name,fn)=>test(name,()=>withDisposableCorePg(f=>fn(f,fixture(f))));
const denied=p=>assert.rejects(p,{code:'CORE_FORBIDDEN',outcome:'undisclosed'});
pg('P11 whole set and replay preserve billed capacity',async(f,x)=>{
 const a=await x.prepare('review');assert.deepEqual(await a.submit(),{replayed:false,result:{}});
 assert.deepEqual(await a.submit(),{replayed:true,result:{}});
 assert.equal((await x.ledger()).record.reservations.length,1);
 assert.ok(x.seen.every(q=>q.executionEffects.length>1));
 assert.ok(x.seen.some(q=>q.executionEffects.some(e=>e.amount==='3'&&e.currency==='USD'&&e.quantity==='2')));
 assert.equal((await f.counts()).commands,1);
});
pg('P11 competing invoices and stale revisions',async(f,x)=>{
 const a=await x.prepare('review'),b=await x.prepare('review',{invoiceId:'I2',requestId:'r2'});
 await a.submit();await assert.rejects(b.submit(),{code:'CORE_REVISION_CONFLICT'});
 await assert.rejects(x.prepare('review',{invoiceId:'I2',requestId:'r3'}),{code:'INVOICE_BILLED_CAPACITY'});
});
pg('P11 approval and linked correction preserve history',async(f,x)=>{
 await (await x.prepare('review')).submit();
 x.time('2026-11-24T15:01:00.000Z');await (await x.prepare('approve',{requestId:'a1'})).submit();
 const before=await x.history('I1',1,'approve');
 x.time('2026-11-24T15:02:00.000Z');x.inputs.get('I1').document.extraction.lines[0].quantity='1';
 await (await x.prepare('review',{requestId:'r2'})).submit();
 assert.equal((await x.current()).record.correctionOf.approvalRef,before.record.approval.approvalRef);
 assert.deepEqual(await x.history('I1',1,'approve'),before);
 assert.equal((await x.ledger()).record.reservations[0].quantity,1);
 assert.equal((await f.counts()).outbox,1);
});
for(const [name,setup] of [
 ['whole-set denial',x=>x.deny(q=>q.stage==='precommit')],
 ['incomplete scope',x=>x.missing(true)],
 ['changed approval',x=>x.changed(true)],
 ['stale policy',x=>x.epoch('v2')],
 ['expired proof',x=>x.time('2026-11-24T15:03:00.000Z')]
])pg('P11 '+name+' rolls back',async(f,x)=>{
 const a=await x.prepare('review');setup(x);await denied(a.submit());assert.equal((await f.counts()).commands,0);
});
pg('P11 postcommit disclosure denial does not undo commit',async(f,x)=>{
 const a=await x.prepare('review');x.deny(q=>q.stage==='projection');await denied(a.submit());
 assert.equal((await f.counts()).commands,1);
});
pg('P11 lost acknowledgement independently inspects local receipt',async(f,x)=>{
 const a=await x.prepare('review');x.lost(true);
 assert.deepEqual(await a.submit(),{replayed:true,result:{}});
 assert.ok(x.seen.some(q=>q.stage==='inspection'&&q.accessEffects.every(e=>e.operation==='purchasing.invoice.receipt.inspect')));
 assert.equal((await f.counts()).commands,1);
});
pg('P11 lost acknowledgement denied inspection retains commit',async(f,x)=>{
 const a=await x.prepare('review');x.lost(true);x.deny(q=>q.stage==='inspection');await denied(a.submit());
 assert.equal((await f.counts()).commands,1);
});
pg('P11 changed source evidence fails closed',async(f,x)=>{
 const a=await x.prepare('review');x.inputs.get('I1').poVersion='P1-v2';await denied(a.submit());assert.equal((await f.counts()).commands,0);
});
