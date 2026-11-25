import {createMock,scenarios} from './mock.js';
import * as C from './consumer.js';
const $=id=>document.getElementById(id);
const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e};
const labels={employees:'Employees',roles:'Roles',registry:'Permission registry',access:'Access explanations'};
let adapter,transport,context,current,query='',cursor=null;
const guard=C.latestOnly();
const scenario=$('scenario'),nav=$('nav'),content=$('content'),status=$('status');
const methods=['searchEmployees','getEmployee','getAssignments','listRoles','getRole','listOperations','explainAccess'];
for(const s of [...scenarios,'delayed',...methods.flatMap(m=>['denied','stale','unavailable','malformed'].map(x=>'request:'+m+':'+x))]){const o=node('option',s);o.value=s;scenario.append(o)}
function state(s){status.textContent=C.messages[s]??''}
function button(label,fn){const b=node('button',label);b.type='button';b.addEventListener('click',fn);return b}
function detail(data,fields){const dl=node('dl');for(const [key,label] of fields){dl.append(node('dt',label),node('dd',Array.isArray(data[key])?data[key].join(', ')||'None':data[key]))}return dl}
function clear(){content.replaceChildren();state('loading');return guard.start()}
async function load(method,args,validator,g){const r=await C.readBound(transport,method,args,validator,context?.policyVersion,{generation:g,current:guard.current,context});if(!guard.current(g)||r.state==='superseded')return null;if(r.state!=='ok'){guard.invalidate();content.replaceChildren();state(r.state);context=null;current=null;nav.replaceChildren();$('context').textContent='';$('heading').textContent='Administration';content.append(button('Reload synthetic context',reset));$('main').focus();return null}state('ok');return r.data}
function showNav(){nav.replaceChildren();for(const p of C.navigation(context)){const b=button(labels[p],()=>open(p,true));if(p===current)b.setAttribute('aria-current','page');nav.append(b)}}
async function reset(){const g=clear(),selected=scenario.value;context=null;current=null;nav.replaceChildren();$('context').textContent='';$('heading').textContent='Administration';adapter=createMock(selected.startsWith('request:')||selected==='delayed'?'normal':selected);const [,target,failure]=selected.split(':');transport=C.fixtureTransport(adapter,async (reply,method)=>{if(selected==='delayed'&&method!=='getAdminContext'){const slow=reply.binding.includes('Mock North')||reply.binding.includes('Avery');await new Promise(resolve=>setTimeout(resolve,slow?600:120));}if(method!==target)return reply;return {...reply,envelope:{...reply.envelope,status:failure==='malformed'?'ok':failure,data:failure==='malformed'?{}:{hidden:'fictional hidden payload'}}}});const d=await load('getAdminContext',{},C.validContext,g);if(!d||!guard.current(g))return;context=d;$('context').textContent=[d.identityLabel,d.environment,d.assuranceState,d.policyVersion].join(' · ');const p=C.navigation(d)[0];if(p)open(p);else{context=null;$('context').textContent='';state('denied');content.append(button('Reload synthetic context',reset))}}
function open(p,focus=false){if(!C.navigation(context).includes(p))return;current=p;query='';cursor=null;showNav();$('heading').textContent=labels[p];if(focus)$('main').focus();if(p==='access')access();else list()}
const configs={
 employees:{method:'searchEmployees',valid:C.validEmployee,fields:[['name','Name'],['status','Status'],['location','Location']]},
 roles:{method:'listRoles',valid:C.validRole,fields:[['label','Role'],['status','Status'],['revision','Revision']]},
 registry:{method:'listOperations',valid:C.validOperation,fields:[['label','Operation'],['domain','Domain'],['tool','Tool'],['description','Description'],['status','Status'],['scopeSchema','Scope'],['prerequisites','Prerequisites'],['approvalRequirements','Approval']]}
};
function field(form,label,value){const l=node('label',label),i=node('input');i.value=value;l.append(i);form.append(l);return i}
async function list(focus=false){if(!C.navigation(context).includes(current)||!configs[current])return;const g=clear(),p=current,c=configs[p];const form=node('form'),input=field(form,'Search '+labels[p],query),submit=node('button','Search');submit.type='submit';form.append(submit);form.addEventListener('submit',e=>{e.preventDefault();if(!form.isConnected||current!==p)return;query=input.value;cursor=null;list(true)});content.append(form);
 if(focus)input.focus();
 input.addEventListener('input',()=>{if(!form.isConnected)return;guard.invalidate();while(form.nextSibling)form.nextSibling.remove();status.textContent='Search changed. Submit to refresh.'});
 const result=await load(c.method,{query,cursor,limit:2},C.validPage(c.valid),g);if(!result||!guard.current(g))return;
 if(!result.items.length)state('empty');
 let group='';
 for(const item of result.items){if(p==='registry'&&group!==item.domain+' / '+item.tool){group=item.domain+' / '+item.tool;content.append(node('h3',group))}
 const a=node('article');a.append(detail(item,c.fields));if(p==='employees'||p==='roles')a.append(button('View details',()=>showDetail(p,item.id)));content.append(a)}
 const controls=node('div');controls.className='controls';if(cursor!==null)controls.append(button('First page',()=>{cursor=null;list(true)}));if(result.nextCursor!==null)controls.append(button('Next page',()=>{cursor=result.nextCursor;list(true)}));content.append(controls)
}
async function showDetail(p,id){if(current!==p||!C.navigation(context).includes(p))return;const g=clear();content.append(button('Back to results',()=>list(true)));$('main').focus();const c=configs[p],d=await load(p==='employees'?'getEmployee':'getRole',p==='employees'?{employeeId:id}:{roleId:id},c.valid,g);if(!d||!guard.current(g))return;content.append(detail(d,c.fields));if(p==='employees'){const a=await load('getAssignments',{employeeId:id},C.validAssignments,g);if(a&&guard.current(g)){content.append(node('h3','Scripted assignments'),detail(a,[['revision','Revision'],['memberships','Roles'],['grants','Individual grants'],['restrictions','Individual restrictions']]))}}}
function access(){const g=clear();if(!C.canExplain(context)){state('denied');return}state('ok');const form=node('form');const employee=field(form,'Synthetic employee ID','mock-e1'),operation=field(form,'Synthetic operation ID','mock-o1'),location=field(form,'Exact location','Mock North'),resource=field(form,'Exact resource','mock-resource-1');for(const i of [employee,operation,location,resource])i.required=true;const submit=node('button','Request explanation');submit.type='submit';form.append(submit);const result=node('section');result.setAttribute('aria-label','Explanation result');content.append(node('p','Scripted explanation only; not execution approval. Change location to Mock South to view a restriction.'),form,result);
 form.addEventListener('input',()=>{if(!form.isConnected)return;guard.invalidate();result.replaceChildren();status.textContent='Scope changed. Request a new explanation.'});
 form.addEventListener('submit',async e=>{e.preventDefault();if(!form.isConnected||!C.canExplain(context)||current!=='access')return;const t=guard.start();result.replaceChildren();state('loading');const d=await load('explainAccess',{employeeId:employee.value,operationId:operation.value,scope:{location:location.value,resource:resource.value}},C.validExplanation,t);if(d&&guard.current(t))result.append(detail(d,[['decision','Backend-supplied decision'],['explanation','Explanation'],['sources','Safe source references']]))})
}
scenario.addEventListener('change',reset);reset();
