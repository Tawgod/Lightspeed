import {createMock02,scenarios} from './mock.js';
import {createController} from './controller.js';
import {intent as validIntent,admitted} from './contract.js';
const $=id=>document.getElementById(id),node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
const content=$('content'),status=$('status'),nav=$('nav'),scenario=$('scenario');
let controller,adapter,epoch=0,draftRules=[],formVersion=0;
const labels={idle:'Choose a fictional target.',loading:'Loading…',editing:'Review current access and prepare a change.',preview:'Review the supplied preview.',confirming:'Confirmation submitted; outcome not yet known.',verified:'Committed synthetic change — independently verified.', 'readback-unverified':'Committed reported; readback unverified. Do not repeat.',unknown:'Outcome unknown. Do not repeat. Inspect status if available.', 'pending-approval':'Pending independent approval. Not committed.',denied:'Access denied.',stale:'Stale or expired request. No automatic retry.',invalid:'Invalid response.',unavailable:'Service unavailable.',unsupported:'Unsupported contract.',authentication_required:'Authentication required through Security.',step_up_required:'Strong authentication required through Security.',approval_required:'Independent approval required.'};
function button(label,fn){const b=node('button',label);b.type='button';b.addEventListener('click',fn);return b}
function field(parent,label,control){const l=node('label',label);l.className='field';l.append(control);parent.append(l);return control}
function select(parent,label,values){const s=node('select');for(const [v,l] of values){const o=node('option',l);o.value=v;s.append(o)}return field(parent,label,s)}
function input(parent,label,value='',type='text'){const n=node('input');n.type=type;n.value=value;return field(parent,label,n)}
function renderRows(title,rows){const a=node('article');a.append(node('h3',title));for(const line of rows)a.append(node('p',line));if(!rows.length)a.append(node('p','None supplied'));content.append(a)}
const expiry=v=>v===null?'No scripted expiry':Number.isFinite(new Date(v).getTime())?new Date(v).toISOString():'Outside displayable date range';
const scopeText=r=>[r.scope.location,r.scope.resourceType,r.scope.resourceId,r.scope.field].join(' / ');
const ruleText=r=>r.kind+' · '+r.operationId+' · '+scopeText(r)+' · '+expiry(r.expiresAt);
function paint(){
 const s=controller.snapshot();status.textContent=labels[s.phase]??'Unable to complete request.';content.replaceChildren();
 // Keep only authorized status controls; never infer from visibility.
 nav.replaceChildren();
 if(!s.locked){
 for(const [label,type,id] of [['Sample floor role','role','mock-r1'],['Sample review role','role','mock-r2'],['Create role','role',null],['Avery Example — mock-e1','employee','mock-e1']]){
  if(!s.context||s.context.allowedNavigation.includes(type==='role'?'roles':'employees'))nav.append(button(label,()=>open(type,id)))
 }
 if(s.selection?.id&&s.selection.type==='role'&&!['mock-r1','mock-r2'].includes(s.selection.id))nav.append(button('Current fictional role',()=>open('role',s.selection.id)))
 }
 if(s.ref&&s.locked&&(!s.context||(s.context.allowedNavigation.includes('changes')&&s.context.allowedActions.includes('getChangeStatus'))))nav.append(button('Inspect change status',async()=>{const e=epoch;const p=controller.inspect();paint();await p;if(e===epoch)paint()}));
 scenario.disabled=s.locked;
 if(!s.context||!s.target)return;
 if(s.target.role){const r=s.target.role;renderRows('Current role',[r.label+' · '+r.id,r.status+' · '+expiry(r.expiresAt),...r.rules.map(ruleText)])}
 if(s.target.memberships){renderRows('Role memberships',s.target.memberships.map(m=>m.roleId+' · '+m.status+' · '+expiry(m.expiresAt)));renderRows('Direct grants',s.target.individual.filter(i=>i.rule.kind==='grant').map(i=>i.status+' · '+ruleText(i.rule)));renderRows('Overriding restrictions',s.target.individual.filter(i=>i.rule.kind==='restrict').map(i=>i.status+' · '+ruleText(i.rule)))}
 if(s.preview){const p=s.preview;const change=p.intent.change;renderRows('Proposed intent',[p.intent.kind,'Reason: '+p.intent.reason,...(change.label?['Role label: '+change.label]:[]),...(change.roleId?['Role: '+change.roleId]:[]),...(change.membershipId?['Membership: '+change.membershipId]:[]),...(change.individualId?['Assignment: '+change.individualId]:[]),...(change.rules??(change.rule?[change.rule]:[])).map(ruleText),...(Object.hasOwn(change,'expiresAt')?['Expiration: '+expiry(change.expiresAt)]:[])]);renderRows('Proposed change — supplied preview',[p.impact.summary,'Gained: '+(p.impact.gained.join('; ')||'None supplied'),'Lost: '+(p.impact.lost.join('; ')||'None supplied'),'Conflicts: '+(p.impact.conflicts.join('; ')||'None supplied'),'Assurance: '+p.requiredAssurance,'Approval: '+p.requiredApproval,'Expires: '+expiry(p.expiresAt)]);
 const confirm=button('Explicitly confirm synthetic change',async()=>{const e=epoch;const task=controller.confirm();paint();await task;if(e===epoch)paint()});confirm.disabled=!admitted('confirmChange',{previewId:p.previewId,expectedRevision:p.intent.expectedRevision},s.context,s.target,p,s.options);content.append(confirm,button('Discard preview',()=>{controller.edit();paint()}));return}
 if(!s.options||s.locked||s.phase==='verified')return;
 const o=s.options;if(!o.allowedChanges.length||!s.context.allowedActions.includes('previewChange')||!s.target.allowedActions.includes('previewChange'))return;
 const form=node('form');form.addEventListener('submit',e=>e.preventDefault());content.append(node('h2','Propose a change'),form);
 const kind=select(form,'Change type',o.allowedChanges.map(k=>[k,({'role.create':'Create role','role.update':'Edit role','role.retire':'Retire role','membership.add':'Add role membership','membership.revoke':'Revoke role membership','individual.add':'Add direct grant or restriction','individual.revoke':'Revoke individual assignment'})[k]]));
 const fields=node('div');fields.className='controls';form.append(fields);
 const reason=input(form,'Reason','Synthetic role review');
 function build(){
  fields.replaceChildren();draftRules=s.target.role?.rules.map(r=>JSON.parse(JSON.stringify(r)))??[];
  const k=kind.value;let name,expires,role,member,individual,op,scope,ruleKind,ruleExpiry;
  const makeExpiry=(parent,label)=>input(parent,label,'','datetime-local');
  const readExpiry=n=>n?.value?new Date(n.value).getTime():null;
  if(k==='role.create'||k==='role.update'){name=input(fields,'Role label',s.target.role?.label??'');expires=makeExpiry(fields,'Role expiration (local time; blank = no scripted expiry)');if(s.target.role?.expiresAt!==null&&s.target.role?.expiresAt!==undefined){const d=new Date(s.target.role.expiresAt);expires.value=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}}
  if(k==='membership.add'){role=select(fields,'Role',o.roles.map(r=>[r.id,r.label+' · '+r.id]));expires=makeExpiry(fields,'Membership expiration (local time)')}
  if(k==='membership.revoke')member=select(fields,'Membership',s.target.memberships.map(m=>[m.id,m.roleId+' · '+m.status+' · '+m.id]));
  if(k==='individual.revoke')individual=select(fields,'Individual assignment',s.target.individual.map(i=>[i.id,i.rule.kind+' · '+i.status+' · '+i.id]));
  if(['role.create','role.update','individual.add'].includes(k)){
   const search=input(fields,'Find permission by supplied operation label or ID');op=select(fields,'Permission',o.operations.map(x=>[x.id,x.label+' · '+x.id]));scope=select(fields,'Exact location / resource / field',[]);
   const refresh=()=>{scope.replaceChildren();const x=o.operations.find(x=>x.id===op.value);for(const [i,t] of (x?.scopes??[]).entries()){const option=node('option',[t.location,t.resourceType,t.resourceId,t.field].join(' / '));option.value=String(i);scope.append(option)}};
   search.addEventListener('input',()=>{op.replaceChildren();for(const x of o.operations.filter(x=>(x.label+' '+x.id).toLowerCase().includes(search.value.toLowerCase()))){const n=node('option',x.label+' · '+x.id);n.value=x.id;op.append(n)}refresh()});op.addEventListener('change',refresh);refresh();
   ruleKind=select(fields,'Assignment kind',[['grant','Grant'],['restrict','Overriding restriction']]);ruleExpiry=makeExpiry(fields,'Rule expiration (local time)');
   const getRule=()=>({operationId:op.value,scope:o.operations.find(x=>x.id===op.value)?.scopes[Number(scope.value)],kind:ruleKind.value,expiresAt:readExpiry(ruleExpiry)});
   if(k!=='individual.add'){const list=node('div');const render=()=>{list.replaceChildren();draftRules.forEach((r,i)=>{const row=node('p',ruleText(r));row.append(button('Remove proposed rule '+(i+1),()=>{draftRules.splice(i,1);render()}));list.append(row)})};fields.append(button('Add proposed rule',()=>{const r=getRule();if(r.scope){draftRules.push(r);render()}}),list);render()}
   if(k==='individual.add')fields.getRule=getRule;
  }
  fields.makeIntent=()=>{
   let change={};if(k==='role.create'||k==='role.update')change={label:name.value.trim(),rules:draftRules,expiresAt:readExpiry(expires)};
   if(k==='membership.add')change={roleId:role.value,expiresAt:readExpiry(expires)};
   if(k==='membership.revoke'){const m=s.target.memberships.find(x=>x.id===member.value);if(!m)return null;change={membershipId:m.id,membershipRevision:m.revision}}
   if(k==='individual.add')change={rule:fields.getRule()};
   if(k==='individual.revoke'){const i=s.target.individual.find(x=>x.id===individual.value);if(!i)return null;change={individualId:i.id,individualRevision:i.revision}}
   return {kind:k,targetType:o.targetType,targetId:o.targetId,expectedRevision:s.target.role?.revision??s.target.revision??null,reason:reason.value.trim(),change}
  };
 }
 kind.addEventListener('change',build);build();form.addEventListener('input',()=>{formVersion++;controller.edit()});
 form.append(button('Request supplied preview',async()=>{const i=fields.makeIntent();if(!validIntent(i)){status.textContent='Complete the change and choose an exact scope.';return}const e=epoch,v=++formVersion;const task=controller.requestPreview(i);status.textContent='Loading preview…';await task;if(e===epoch&&v===formVersion)paint()}));
}
async function open(type,id){epoch++;const e=epoch;const p=controller.open(type,id);paint();await p;if(e===epoch)paint()}
function reset(){if(controller?.snapshot().locked)return;epoch++;adapter=createMock02(scenario.value);controller=createController(adapter);open('employee','mock-e1')}
for(const s of scenarios){const o=node('option',s);o.value=s;scenario.append(o)}scenario.addEventListener('change',reset);reset();
