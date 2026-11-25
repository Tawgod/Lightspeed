import test from 'node:test';
import assert from 'node:assert/strict';
import {VERSION as OLD,createOfflineAuthorization,executionScopeDigest,validateOfflineAllow} from './fixtures/hc-secure-s25h-contract.mjs';
import {syntheticServiceExecutionBinding} from './fixtures/hc-secure-s25g-lifecycle.mjs';
const now=2000000,live={active:true,revoked:false,startsAt:0,expiresAt:now+100000};
const actor={realm:'employee',id:'e1',tenant:'fixture',environment:'test',jobId:null,jobRevision:null,delegationId:null,audience:null};
const employee={realm:'employee',id:'e1',tenant:'fixture',active:true};
const session={...live,id:'s1',actorId:'e1',tenant:'fixture',deviceId:'d1',locked:false,method:'timeclock-pin',offsiteAllowed:false};
const device={...live,id:'d1',tenant:'fixture',kind:'personal',actorId:'e1'};
const site={...live,id:'site1',tenant:'fixture',deviceId:'d1',sessionId:'s1',verified:true,networkClass:'trusted-store'};
const strongProof={...live,actorId:'e1',tenant:'fixture',sessionId:'s1',deviceId:'d1',verifiedAt:now-100};
const effect=(operation,field='cost')=>({operation,tenant:'fixture',environment:'test',location:'store-a',resourceType:'invoice',resourceId:'i1',field,revision:'r1',relationships:[{type:'supplier',id:'sup1'}],quantity:'2',amount:'12.5',currency:'USD',purpose:'invoice-review',audience:'purchasing'});
const cost=effect('purchasing.invoice.execute'),read=effect('purchasing.invoice.read','description'),inspect=effect('purchasing.invoice.receipt.inspect','receipt'),admin=effect('security.settings.modify');
const registry=[{operation:cost.operation,mode:'execute',required:['revision','relationships','quantity','amount','currency'],approvalRequired:true,assurance:'business'},{operation:read.operation,mode:'read',required:['revision','purpose','audience'],approvalRequired:false,assurance:'business'},{operation:inspect.operation,mode:'inspect',required:['revision','purpose','audience'],approvalRequired:false,assurance:'business'},{operation:admin.operation,mode:'execute',required:['revision'],approvalRequired:false,assurance:'security-admin'}];
const narrow=({operation,tenant,environment,location,resourceType,resourceId,field})=>({operation,tenant,environment,location,resourceType,resourceId,field});
const q={version:OLD,requestId:'req1',correlationId:'c1',stage:'admission',actor,evidenceRef:'ev1',executionDigest:'a'.repeat(64),executionEffects:[cost],accessEffects:[],approvalId:'ap1',policyVersion:'v1'};
const policy={tenant:'fixture',environment:'test',version:'v1',roles:[{id:'r',active:true,rules:[cost,read,inspect,admin].map((e,i)=>({id:'r'+i,kind:'grant',effect:narrow(e),startsAt:0,expiresAt:now+100000,revoked:false}))}],assignments:[{id:'a',actorId:'e1',roleId:'r',startsAt:0,expiresAt:now+100000,revoked:false}],individual:[]};
const approval={id:'ap1',scopeDigest:executionScopeDigest(q),actorId:'e1',tenant:'fixture',approved:true,revoked:false,reviewerAuthorized:true,reviewerId:'e2',expiresAt:now+100000};
const state={evidenceRef:'ev1',policyVersion:'v1',employee,session,device,site,strongProof,settings:{version:'v1',adminFreshnessMs:200},policy,approval,admittedScopes:[cost,read,inspect,admin]};
const build=(s=state,version=()=> 'v1',clock=()=>now)=>createOfflineAuthorization({registry,readTrustedState:async()=>s,readPolicyVersion:async()=>version(),clock,decisionMaxMs:50});
const sq={...q,actor:{realm:'service',id:'svc1',tenant:'fixture',environment:'test',jobId:'j1',jobRevision:'jr1',delegationId:'dg1',audience:'purchasing'}};
const sr={actor:{realm:'service',id:'svc1',tenant:'fixture',environment:'test'},audience:'purchasing',jobId:'j1',jobRevision:'jr1',delegationId:'dg1',stage:'dispatch',executionEffects:[narrow(cost)],accessEffects:[],fingerprint:executionScopeDigest(sq),approvalId:'ap1'};
const sb=syntheticServiceExecutionBinding(sr);
const rules=[cost,read,inspect].map(e=>({...live,kind:'grant',effect:narrow(e)}));
const common={...live,serviceId:'svc1',jobId:'j1',jobRevision:'jr1',tenant:'fixture',environment:'test',audience:'purchasing',executionBinding:sb,rules};
const serviceState={version:'v1',service:{...live,id:'svc1',tenant:'fixture',environment:'test',credentialRevision:'k1',rules},proof:{...live,kind:'service-proof',serviceId:'svc1',tenant:'fixture',environment:'test',audience:'purchasing',credentialRevision:'k1'},job:{...common,id:'j1',revision:'jr1',ownerId:'e1',kind:'delegated'},delegation:{...common,id:'dg1',employeeId:'e1'},delegator:employee,delegatorPolicy:policy,approval:{...live,id:'ap1',executionBinding:sb,tenant:'fixture',environment:'test',approved:true,reviewerAuthorized:true,reviewerId:'e2'}};
const ss={...state,serviceState,approval:{...approval,actorId:'svc1',scopeDigest:executionScopeDigest(sq)}};


import {VERSION,createProvenanceCandidate,createIndependentInspection} from './fixtures/hc-secure-s25k-provenance.mjs';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const request={...q,version:VERSION};
const make=(initial=state,reg=registry)=>{
 let s=structuredClone(initial),revision='er1',epoch='v1',t=now,expiry=now+90000,alter=x=>x;
 const f=createProvenanceCandidate({registry:reg,clock:()=>t,decisionMaxMs:4000000,readPolicyVersion:async()=>epoch,readEvidenceRevision:async()=>revision,
 readEvidence:async q=>alter({issuer:'synthetic-security-authority',tenant:q.actor.tenant,environment:q.actor.environment,reference:q.evidenceRef,revision,observedAt:now-1,expiresAt:expiry,policyVersion:epoch,snapshotDigest:hash(s),state:s})});
 return {f,s,revision:x=>revision=x,epoch:x=>epoch=x,time:x=>t=x,expiry:x=>expiry=x,alter:x=>alter=x};
};
test('provenance caps lifetime by authority observation',async()=>{const x=make();x.expiry(now+9);const r=await x.f.issue(request);assert.equal(r.allowed,true);assert.equal(r.expiresAt,now+9);assert.equal(r.authorityRevision,'er1')});
test('bad issuer, scope, reference, digest or observation deny',async()=>{for(const patch of [{issuer:'client'},{tenant:'other'},{environment:'production'},{reference:'other'},{snapshotDigest:'bad'},{observedAt:now+1},{expiresAt:now},{revision:'wrong'},{policyVersion:'v0'}]){const x=make();x.alter(e=>({...e,...patch}));assert.equal((await x.f.issue(request)).allowed,false)}});
test('independent evidence revision change denies consumption',async()=>{const x=make();const r=await x.f.issue(request);x.revision('er2');assert.equal(await x.f.consume(request,r),false)});
test('policy change denies consumption',async()=>{const x=make();const r=await x.f.issue(request);x.epoch('v2');assert.equal(await x.f.consume(request,r),false)});
test('concurrent consumes allow only one',async()=>{const x=make(),r=await x.f.issue(request);assert.equal((await Promise.all([x.f.consume(request,r),x.f.consume(request,r)])).filter(Boolean).length,1)});
test('different stage or approval burns decision',async()=>{for(const change of [{stage:'dispatch'},{approvalId:'replacement'}]){const x=make(),r=await x.f.issue(request);assert.equal(await x.f.consume({...request,...change},r),false);assert.equal(await x.f.consume(request,r),false)}});
test('expiry boundary denies consumption',async()=>{const x=make();x.expiry(now+1);const r=await x.f.issue(request);x.time(now+1);assert.equal(await x.f.consume(request,r),false)});
test('delegated service loses authority on revocation',async()=>{const x=make(ss),req={...sq,version:VERSION},r=await x.f.issue(req);assert.equal(r.allowed,true);x.s.serviceState.delegation.revoked=true;assert.equal(await x.f.consume(req,r),false)});
test('standing service deadline and revocation',async()=>{const a={...sq.actor,delegationId:null},req={...sq,actor:a,version:VERSION},binding=syntheticServiceExecutionBinding({...sr,delegationId:null,fingerprint:executionScopeDigest(req)});const st={...ss,approval:{...ss.approval,scopeDigest:executionScopeDigest(req)},serviceState:{...serviceState,delegation:null,job:{...serviceState.job,kind:'standing',executionBinding:binding},standing:{...common,ownerId:'e1',executionBinding:binding,approved:true,expiresAt:now+8},approval:{...serviceState.approval,executionBinding:binding}}};const x=make(st),r=await x.f.issue(req);assert.equal(r.allowed,true);assert.equal(r.expiresAt,now+8);x.s.serviceState.standing.revoked=true;assert.equal(await x.f.consume(req,r),false)});
test('sensitive offsite proof is non-sliding and expires at exact boundary',async()=>{const reg=registry.map(d=>d.operation===cost.operation?{...d,assurance:'offsite-sensitive'}:d);const x=make({...state,site:null,session:{...session,method:'strong',offsiteAllowed:true},strongProof:{...strongProof,verifiedAt:now-1799990}},reg);const r=await x.f.issue(request);assert.equal(r.allowed,true);assert.equal(r.expiresAt,now+10);x.time(now+10);assert.equal((await x.f.issue(request)).allowed,false)});
const ie={...inspect,quantity:null,amount:null,currency:null};
const iq={version:'HC-RECONCILE/0.1-candidate',requestId:'i1',actor:'e9',tenant:'fixture',environment:'test',recordId:'receipt1',commandDigest:q.executionDigest,approvalRef:q.approvalId,recordRevision:'rr1',effect:ie,policyVersion:'v1',evidenceRef:'inspector1'};
function inspector(){
 const r={id:iq.recordId,tenant:iq.tenant,environment:'test',originalActor:'e1',commandDigest:iq.commandDigest,approvalRef:iq.approvalRef,revision:iq.recordRevision,inspectEffect:ie,outcome:'unknown'};
 const s={issuer:'synthetic-security-authority',reference:iq.evidenceRef,revision:'er1',expiresAt:now+100,policyVersion:'v1',employee:{...employee,id:'e9'},session:{...session,actorId:'e9'},device:{...device,actorId:'e9'},site,strongProof:{...strongProof,actorId:'e9'},settings:state.settings,policy:{...policy,roles:[{id:'r',active:true,rules:[{...policy.roles[0].rules[2],effect:narrow(ie)}]}],assignments:[{...policy.assignments[0],actorId:'e9'}]},admittedScopes:[ie]};
 let epoch='v1',revision='er1',calls=0,change=false;
 const inspect=createIndependentInspection({operations:[ie.operation],clock:()=>now,readRecord:async()=>{if(change&&++calls>1)return {...r,revision:'changed'};return r},readAuthority:async()=>s,readPolicyVersion:async()=>epoch,readEvidenceRevision:async()=>revision});
 return {r,s,inspect,epoch:x=>epoch=x,revision:x=>revision=x,change:()=>change=true};
}
test('independent inspector receives minimal unknown projection',async()=>{const x=inspector();assert.deepEqual(await x.inspect(iq),{allowed:true,requestId:'i1',recordId:'receipt1',revision:'rr1',outcome:'unknown',retryAllowed:false,releaseAllowed:false})});
test('original actor, substituted approval, digest, record and resource denied',async()=>{for(const patch of [{actor:'e1'},{approvalRef:'replacement'},{commandDigest:'b'.repeat(64)},{recordRevision:'other'},{effect:{...ie,resourceId:'other'}},{effect:{...ie,operation:cost.operation}}])assert.equal((await inspector().inspect({...iq,...patch})).allowed,false)});
test('inspector requires current separate grant, assurance and evidence',async()=>{for(const revoke of [x=>x.s.employee.active=false,x=>x.s.session.revoked=true,x=>x.s.strongProof.revoked=true,x=>x.s.policy.assignments[0].revoked=true,x=>x.s.admittedScopes=[],x=>x.s.expiresAt=now,x=>x.revision('er2'),x=>x.epoch('v2')]){const x=inspector();revoke(x);assert.equal((await x.inspect(iq)).allowed,false)}});
test('record mutation during independent inspection denies',async()=>{const x=inspector();x.change();assert.equal((await x.inspect(iq)).allowed,false)});
test('committed observation still cannot retry or release',async()=>{const x=inspector();x.r.outcome='committed';const r=await x.inspect(iq);assert.equal(r.allowed,true);assert.equal(r.retryAllowed,false);assert.equal(r.releaseAllowed,false)});
