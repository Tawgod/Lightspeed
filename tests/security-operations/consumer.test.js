import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createMock,scenarios} from '../../ui/security-operations/mock.js';import * as C from '../../ui/security-operations/consumer.js';
const mock=createMock();
test('context and navigation supplied by adapter',async()=>{const r=await C.read(mock.getAdminContext,C.validContext);assert.equal(r.state,'ok');assert.equal(C.navigation(r.data).length,4);assert.equal(C.canExplain(r.data),true);assert.equal(C.canExplain({...r.data,allowedActions:[]}),false);assert.deepEqual(C.navigation({...r.data,allowedNavigation:undefined}),[])});
test('employee paging and search',async()=>{const a=await mock.searchEmployees({limit:2});assert.equal(a.data.items.length,2);const b=await mock.searchEmployees({cursor:a.data.nextCursor,limit:2});assert.equal(b.data.items.length,1);assert.equal(b.data.nextCursor,null);assert.equal((await mock.searchEmployees({query:'morgan'})).data.items[0].id,'mock-e2');assert.equal((await mock.searchEmployees({cursor:'bad'})).status,'invalid')});
test('detail and assignments',async()=>{assert.equal((await C.read(()=>mock.getEmployee({employeeId:'mock-e1'}),C.validEmployee)).state,'ok');assert.equal((await C.read(()=>mock.getAssignments({employeeId:'mock-e1'}),C.validAssignments)).data.memberships.length,2);assert.equal((await mock.getEmployee({employeeId:'unknown'})).status,'denied')});
test('roles and registry searchable',async()=>{assert.equal((await mock.listRoles({query:'review'})).data.items.length,1);assert.equal((await mock.listOperations({query:'cost',limit:20})).data.items.length,3);assert.equal((await C.read(()=>mock.listOperations({limit:20}),C.validPage(C.validOperation))).state,'ok')});
test('scripted exact scope outcomes',async()=>{for(const [location,decision] of [['Mock North','allowed'],['Mock South','denied'],['Other','unknown']]){const r=await C.read(()=>mock.explainAccess({employeeId:'mock-e1',operationId:'mock-o1',scope:{location,resource:'mock-resource-1'}}),C.validExplanation);assert.equal(r.data.decision,decision)}});
for(const s of scenarios.filter(s=>!['normal','empty'].includes(s)))test('fails closed: '+s,async()=>{const r=await C.read(createMock(s).getAdminContext,C.validContext);assert.equal(r.state,s==='missing'?'invalid':s);assert.equal(r.data,undefined)});
test('empty results',async()=>{const r=await C.read(()=>createMock('empty').searchEmployees({}),C.validPage(C.validEmployee));assert.deepEqual(r.data.items,[])});
test('unknown state and malformed records',()=>{assert.equal(C.decode({contractVersion:'0.1.0',requestId:'x',status:'future'},()=>true).state,'unsupported');assert.equal(C.decode({contractVersion:'0.1.0',requestId:'x',status:'ok',data:{items:[{}],nextCursor:null}},C.validPage(C.validEmployee)).state,'invalid')});
test('non-ok payload discarded',()=>{assert.deepEqual(C.decode({contractVersion:'0.1.0',requestId:'x',status:'denied',data:{secret:'x'}},()=>true),{state:'denied'})});
test('late response invalidation',()=>{const g=C.latestOnly(),a=g.start(),b=g.start();assert.equal(g.current(a),false);assert.equal(g.current(b),true);g.invalidate();assert.equal(g.current(b),false)});
test('static browser safety and accessible structure',()=>{const root=new URL('../../ui/security-operations/',import.meta.url);const html=readFileSync(new URL('index.html',root),'utf8'),app=readFileSync(new URL('app.js',root),'utf8'),css=readFileSync(new URL('styles.css',root),'utf8');assert.match(html,/connect-src 'none'/);assert.match(html,/form-action 'none'/);assert.match(html,/aria-live="polite"/);assert.match(html,/lang="en"/);assert.match(app,/textContent/);assert.doesNotMatch(app,/innerHTML|insertAdjacentHTML|fetch\s*\(|XMLHttpRequest/);assert.match(css,/@media/);assert.match(css,/:focus-visible/)});

const args={employeeId:'mock-e1',operationId:'mock-o1',scope:{location:'Mock North',resource:'mock-resource-1'}};
const policy='mock-policy-1';
const opts={context:await mock.getAdminContext().then(r=>r.data),generation:1};
const cases=[['searchEmployees',{},C.validPage(C.validEmployee)],['getEmployee',{employeeId:'mock-e1'},C.validEmployee],['listRoles',{},C.validPage(C.validRole)],['getRole',{roleId:'mock-r1'},C.validRole],['listOperations',{},C.validPage(C.validOperation)],['getAssignments',{employeeId:'mock-e1'},C.validAssignments],['explainAccess',args,C.validExplanation]];
for(const [method,input,validator] of cases)test('bound request-specific failures '+method,async()=>{
 const ctx=await C.readBound(C.fixtureTransport(mock),'getAdminContext',{},C.validContext);
 assert.equal(ctx.state,'ok');
 assert.equal((await C.readBound(C.fixtureTransport(mock),method,input,validator,policy,opts)).state,'ok');
 for(const status of ['denied','stale','unavailable','authentication_required','step_up_required','approval_required','invalid']){
  const t=C.fixtureTransport(mock,r=>({...r,envelope:{...r.envelope,status,data:{secret:'hidden'}}}));
  assert.deepEqual(await C.readBound(t,method,input,validator,policy,opts),{state:status});
 }
 const malformed=C.fixtureTransport(mock,r=>({...r,envelope:{...r.envelope,data:{}}}));
 assert.deepEqual(await C.readBound(malformed,method,input,validator,policy,opts),{state:'invalid'});
});
test('unique synthetic request identifiers',async()=>{assert.notEqual((await mock.getAdminContext()).requestId,(await mock.getAdminContext()).requestId);const seen=[];const t=C.fixtureTransport(mock,r=>{seen.push(r.envelope.requestId);return r});await C.readBound(t,'getAdminContext',{},C.validContext);await C.readBound(t,'getAdminContext',{},C.validContext);assert.notEqual(...seen)});
test('local fixture binding mismatch or omission fails closed',async()=>{
 for(const alter of [r=>({...r,binding:undefined}),r=>({...r,binding:'[]'}),r=>({...r,binding:r.binding.replace('mock-e1','mock-e2')}),r=>({...r,binding:r.binding.replace('mock-o1','mock-o2')}),r=>({...r,binding:r.binding.replace('Mock North','Mock South')}),r=>({...r,envelope:{...r.envelope,requestId:'wrong'}}),r=>({...r,envelope:{...r.envelope,requestId:undefined}})]){
 assert.deepEqual(await C.readBound(C.fixtureTransport(mock,alter),'explainAccess',args,C.validExplanation,policy,opts),{state:'invalid'});
 }
});
test('wrong detail subject fails closed',async()=>{for(const [method,input,validator] of cases.filter(x=>['getEmployee','getRole'].includes(x[0]))){const t=C.fixtureTransport(mock,r=>({...r,envelope:{...r.envelope,data:{...r.envelope.data,id:'wrong'}}}));assert.deepEqual(await C.readBound(t,method,input,validator,policy,opts),{state:'invalid'})}});
test('policy mismatch and absence fail closed in fixture profile',async()=>{for(const policyVersion of [undefined,'wrong']){const t=C.fixtureTransport(mock,r=>({...r,envelope:{...r.envelope,policyVersion}}));assert.deepEqual(await C.readBound(t,'explainAccess',args,C.validExplanation,policy,opts),{state:'stale'})}});
test('partial explanation scope rejected before invocation',async()=>{for(const scope of [{location:'Mock North'},{resource:'mock-resource-1'},{location:' ',resource:'x'}]){assert.deepEqual(await C.readBound(()=>assert.fail('must not call'),'explainAccess',{...args,scope},C.validExplanation,policy,opts),{state:'invalid'})}});
test('missing capabilities suppress navigation and explanations',async()=>{const r=await C.readBound(C.fixtureTransport(mock,r=>({...r,envelope:{...r.envelope,data:{...r.envelope.data,allowedActions:undefined}}})),'getAdminContext',{},C.validContext);assert.deepEqual(r,{state:'invalid'});assert.deepEqual(C.navigation(r.data),[]);assert.equal(C.canExplain(r.data),false)});
test('out-of-order fixture replies discarded by generation guard',async()=>{const guard=C.latestOnly(),pending=[];const t=C.fixtureTransport(mock);const delayed=(...a)=>new Promise(resolve=>pending.push(()=>resolve(t(...a))));const first=guard.start(),a=C.readBound(delayed,'explainAccess',args,C.validExplanation,policy,opts);const second=guard.start(),b=C.readBound(delayed,'explainAccess',{...args,scope:{...args.scope,location:'Mock South'}},C.validExplanation,policy,opts);pending[1]();assert.equal((await b).data.decision,'denied');assert.equal(guard.current(second),true);pending[0]();assert.equal((await a).data.decision,'allowed');assert.equal(guard.current(first),false);guard.invalidate();assert.equal(guard.current(second),false)});

test('adapter originates immutable invocation binding',async()=>{
 const request=Object.freeze({method:'getAssignments',args:Object.freeze({employeeId:'mock-e1'}),id:'local-test',generation:42,policy});
 const r=await mock.invoke(request);assert.equal(r.binding,JSON.stringify([request.method,request.args,42,policy]));assert.equal(r.envelope.requestId,request.id);
 const arbitrary={invoke:async()=>({envelope:{contractVersion:'0.1.0',requestId:'wrong',status:'ok',policyVersion:policy,data:{}}})};
 assert.deepEqual(await C.readBound(C.fixtureTransport(arbitrary),'getAssignments',request.args,C.validAssignments,policy,opts),{state:'invalid'});
});
test('missing capabilities prevent all downstream invocation',async()=>{
 for(const [method,input,validator] of cases){
  const context={...opts.context,allowedNavigation:[],allowedActions:[]};let calls=0;
  assert.deepEqual(await C.readBound(()=>{calls++},method,input,validator,policy,{...opts,context}),{state:'denied'});assert.equal(calls,0);
 }
 let calls=0;assert.deepEqual(await C.readBound(()=>{calls++},'explainAccess',args,C.validExplanation,policy,{...opts,context:{...opts.context,allowedActions:[]}}),{state:'denied'});assert.equal(calls,0);
});
test('generation and expected policy binding mismatch',async()=>{
 for(const change of [r=>({...r,binding:JSON.stringify(['getAssignments',{employeeId:'mock-e1'},99,policy])}),r=>({...r,binding:JSON.stringify(['getAssignments',{employeeId:'mock-e1'},1,'wrong'])}),r=>({...r,binding:r.binding.replace('mock-e1','mock-e2')})]){
 assert.deepEqual(await C.readBound(C.fixtureTransport(mock,change),'getAssignments',{employeeId:'mock-e1'},C.validAssignments,policy,opts),{state:'invalid'});
 }
});
test('superseded successes, denied responses and throws never escape guard',async()=>{
 for(const outcome of ['ok','denied','throw']){
 const g=C.latestOnly(),generation=g.start();let release;const wait=new Promise(resolve=>{release=resolve});
 const transport=async req=>{await wait;if(outcome==='throw')throw Error('hidden');const r=await mock.invoke(req);return outcome==='denied'?{...r,envelope:{...r.envelope,status:'denied',data:{secret:'hidden'}}}:r};
 const p=C.readBound(transport,'explainAccess',args,C.validExplanation,policy,{...opts,generation,current:g.current});g.invalidate();release();assert.deepEqual(await p,{state:'superseded'});
 }
});

test('bootstrap rejects blank, whitespace and mismatched policy versions',async()=>{
 for(const [envelopePolicy,dataPolicy,state] of [['','','invalid'],['   ','   ','invalid'],['wrong',policy,'stale'],[undefined,policy,'stale']]){
  const transport=C.fixtureTransport(mock,r=>({...r,envelope:{...r.envelope,policyVersion:envelopePolicy,data:{...r.envelope.data,policyVersion:dataPolicy}}}));
  assert.deepEqual(await C.readBound(transport,'getAdminContext',{},C.validContext),{state});
 }
});
test('blank policy or missing explanation capability prevents invocation',async()=>{
 for(const context of [{...opts.context,policyVersion:' '},{...opts.context,allowedActions:[]}]){
  let calls=0;assert.deepEqual(await C.readBound(()=>{calls++},'explainAccess',args,C.validExplanation,context.policyVersion,{...opts,context}),{state:'denied'});assert.equal(calls,0);
 }
});
