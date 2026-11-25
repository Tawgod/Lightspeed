import {createMock,scenarios} from './mock.js';
import * as C from './consumer.js';
const $=id=>document.getElementById(id);
const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e};
const labels={employees:'Employees',roles:'Roles',registry:'Permission registry',access:'Access explanations'};
let adapter,context,current,query='',cursor=null;
const guard=C.latestOnly();
const scenario=$('scenario'),nav=$('nav'),content=$('content'),status=$('status');
for(const s of scenarios){const o=node('option',s);o.value=s;scenario.append(o)}
function state(s){status.textContent=C.messages[s]??''}
function button(label,fn){const b=node('button',label);b.type='button';b.addEventListener('click',fn);return b}
function detail(data,fields){const dl=node('dl');for(const [key,label] of fields){dl.append(node('dt',label),node('dd',Array.isArray(data[key])?data[key].join(', ')||'None':data[key]))}return dl}
function clear(){content.replaceChildren();state('loading');return guard.start()}
async function load(method,validator,g){const r=await C.read(method,validator);if(!guard.current(g))return null;if(r.state!=='ok'){state(r.state);return null}state('ok');return r.data}
function showNav(){nav.replaceChildren();for(const p of C.navigation(context)){const b=button(labels[p],()=>open(p,true));if(p===current)b.setAttribute('aria-current','page');nav.append(b)}}
async function reset(){const g=clear();context=null;current=null;nav.replaceChildren();$('context').textContent='';adapter=createMock(scenario.value);const d=await load(()=>adapter.getAdminContext(),C.validContext,g);if(!d)return;context=d;$('context').textContent=[d.identityLabel,d.environment,d.assuranceState,d.policyVersion].join(' · ');const p=C.navigation(d)[0];if(p)open(p);else state('denied')}
function open(p,focus=false){if(!C.navigation(context).includes(p))return;current=p;query='';cursor=null;showNav();$('heading').textContent=labels[p];if(focus)$('main').focus();if(p==='access')access();else list()}
const configs={
 employees:{method:'searchEmployees',valid:C.validEmployee,fields:[['name','Name'],['status','Status'],['location','Location']]},
 roles:{method:'listRoles',valid:C.validRole,fields:[['label','Role'],['status','Status'],['revision','Revision']]},
 registry:{method:'listOperations',valid:C.validOperation,fields:[['label','Operation'],['domain','Domain'],['tool','Tool'],['description','Description'],['status','Status'],['scopeSchema','Scope'],['prerequisites','Prerequisites'],['approvalRequirements','Approval']]}
};
function field(form,label,value){const l=node('label',label),i=node('input');i.value=value;l.append(i);form.append(l);return i}
async function list(focus=false){const g=clear(),p=current,c=configs[p];const form=node('form'),input=field(form,'Search '+labels[p],query),submit=node('button','Search');submit.type='submit';form.append(submit);form.addEventListener('submit',e=>{e.preventDefault();query=input.value;cursor=null;list(true)});content.append(form);
 if(focus)input.focus();
 const result=await load(()=>adapter[c.method]({query,cursor,limit:2}),C.validPage(c.valid),g);if(!result)return;
 if(!result.items.length)state('empty');
 let group='';
 for(const item of result.items){if(p==='registry'&&group!==item.domain+' / '+item.tool){group=item.domain+' / '+item.tool;content.append(node('h3',group))}
 const a=node('article');a.append(detail(item,c.fields));if(p==='employees'||p==='roles')a.append(button('View details',()=>showDetail(p,item.id)));content.append(a)}
 const controls=node('div');controls.className='controls';if(cursor!==null)controls.append(button('First page',()=>{cursor=null;list(true)}));if(result.nextCursor!==null)controls.append(button('Next page',()=>{cursor=result.nextCursor;list(true)}));content.append(controls)
}
async function showDetail(p,id){const g=clear();content.append(button('Back to results',()=>list(true)));$('main').focus();const c=configs[p],d=await load(()=>p==='employees'?adapter.getEmployee({employeeId:id}):adapter.getRole({roleId:id}),c.valid,g);if(!d)return;content.append(detail(d,c.fields));if(p==='employees'){const a=await load(()=>adapter.getAssignments({employeeId:id}),C.validAssignments,g);if(a){content.append(node('h3','Scripted assignments'),detail(a,[['revision','Revision'],['memberships','Roles'],['grants','Individual grants'],['restrictions','Individual restrictions']]))}}}
function access(){const g=clear();if(!C.canExplain(context)){state('denied');return}state('ok');const form=node('form');const employee=field(form,'Synthetic employee ID','mock-e1'),operation=field(form,'Synthetic operation ID','mock-o1'),location=field(form,'Exact location','Mock North'),resource=field(form,'Exact resource','mock-resource-1');for(const i of [employee,operation,location,resource])i.required=true;const submit=node('button','Request explanation');submit.type='submit';form.append(submit);const result=node('section');result.setAttribute('aria-label','Explanation result');content.append(node('p','Scripted explanation only; not execution approval. Change location to Mock South to view a restriction.'),form,result);
 form.addEventListener('input',()=>{guard.invalidate();result.replaceChildren();state('ok')});
 form.addEventListener('submit',async e=>{e.preventDefault();if(!C.canExplain(context)||current!=='access')return;const t=guard.start();result.replaceChildren();state('loading');const d=await load(()=>adapter.explainAccess({employeeId:employee.value,operationId:operation.value,scope:{location:location.value,resource:resource.value}}),C.validExplanation,t);if(d)result.append(detail(d,[['decision','Backend-supplied decision'],['explanation','Explanation'],['sources','Safe source references']]))})
}
scenario.addEventListener('change',reset);reset();
