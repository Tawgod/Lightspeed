import {createMock02,scenarios} from './mock.js';
import {createController} from './controller.js';
import {intent as validIntent,admitted} from './contract.js';
const $=id=>document.getElementById(id),node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
const content=$('content'),status=$('status'),nav=$('nav'),scenario=$('scenario');
let controller,adapter,epoch=0,draftRules=[],formVersion=0,currentPanel,editorPanel;
const changeLabels={'role.create':'Create role','role.update':'Edit role permissions','role.retire':'Retire role','membership.add':'Assign another role','membership.revoke':'Remove role membership','individual.add':'Add individual permission or restriction','individual.revoke':'Revoke individual assignment'};
// Presentation-only labels for exact fictional tuples; never synthesize authority.
const friendlyScope=s=>[s.location==='mock-north'?'North example store':s.location==='mock-south'?'South example store':s.location,s.resourceType==='product'?'Product':s.resourceType,s.resourceId==='mock-p1'?'Sample product 1':s.resourceId==='mock-p2'?'Sample product 2':s.resourceId,s.field==='cost'?'Cost information':s.field==='description'?'Product description':s.field].join(' · ');
const roleLabel=(id,s)=>s.options?.roles.find(r=>r.id===id)?.label??id;
const operationLabel=(id,s)=>s.options?.operations.find(r=>r.id===id)?.label??id;
const labels={idle:'Choose a fictional target.',loading:'Loading…',editing:'Review current access and prepare a change.',preview:'Review the supplied preview.',confirming:'Confirmation submitted; outcome not yet known.',verified:'Committed synthetic change — independently verified.', 'readback-unverified':'Committed reported; readback unverified. Do not repeat.',unknown:'Outcome unknown. Do not repeat. Inspect status if available.', 'pending-approval':'Pending independent approval. Not committed.',denied:'Access denied.',stale:'Stale or expired request. No automatic retry.',invalid:'Invalid response.',unavailable:'Service unavailable.',unsupported:'Unsupported contract.',authentication_required:'Authentication required through Security.',step_up_required:'Strong authentication required through Security.',approval_required:'Independent approval required.'};
function button(label,fn){const b=node('button',label);b.type='button';b.addEventListener('click',fn);return b}
function field(parent,label,control){const l=node('label',label);l.className='field';l.append(control);parent.append(l);return control}
function select(parent,label,values){const s=node('select');for(const [v,l] of values){const o=node('option',l);o.value=v;s.append(o)}return field(parent,label,s)}
function input(parent,label,value='',type='text'){const n=node('input');n.type=type;n.value=value;return field(parent,label,n)}
function renderRows(title,rows,panel=currentPanel){const a=node('article');a.append(node('h3',title));for(const line of rows){const p=node('p',line);p.className='record-line';a.append(p)}if(!rows.length)a.append(node('p','None supplied'));panel.append(a)}
const expiry=v=>v===null?'No scripted expiry':Number.isFinite(new Date(v).getTime())?new Date(v).toISOString():'Outside displayable date range';
const ruleText=(r,s=controller.snapshot())=>(r.kind==='grant'?'Grant':'Restriction')+' — '+operationLabel(r.operationId,s)+' · '+friendlyScope(r.scope)+' · '+expiry(r.expiresAt)+' ['+r.operationId+']';
function paint(){
 const s=controller.snapshot();status.textContent=labels[s.phase]??'Unable to complete request.';content.replaceChildren();
 // Keep only authorized status controls; never infer from visibility.
 nav.replaceChildren();
 if(!s.locked){
 for(const [heading,entries] of [['Employees',[['Avery Example','employee','mock-e1']]],['Roles',[['Sample floor role','role','mock-r1'],['Sample review role','role','mock-r2'],['Create role','role',null]]]]){
  const allowed=entries.filter(([,type])=>!s.context||s.context.allowedNavigation.includes(type==='role'?'roles':'employees'));if(!allowed.length)continue;const h=node('p',heading);h.className='nav-heading';nav.append(h);
  for(const [label,type,id] of allowed){const b=button(label,()=>open(type,id));if(s.selection?.type===type&&s.selection.id===id)b.setAttribute('aria-current','page');nav.append(b)}
 }
 if(s.context?.allowedNavigation.includes('roles')&&s.selection?.id&&s.selection.type==='role'&&!['mock-r1','mock-r2'].includes(s.selection.id))nav.append(button('Current fictional role',()=>open('role',s.selection.id)))
 }
 if(s.ref&&s.locked&&s.phase!=='loading'&&(!s.context||(s.context.allowedNavigation.includes('changes')&&s.context.allowedActions.includes('getChangeStatus'))))nav.append(button('Inspect change status',async()=>{const e=epoch;const p=controller.inspect();paint();await p;if(e===epoch)paint()}));
 scenario.disabled=s.locked;
 if(!s.context||!s.target)return;
 const heading=node('h2',s.selection?.type==='employee'?'Avery Example — employee access':s.target.role?s.target.role.label+' — role configuration':'Create a new role');content.append(heading);
 const meta=node('p',s.selection?.id?'Fictional record ID: '+s.selection.id:'A new reusable permission set.');meta.className='muted';content.append(meta);
 const workspace=node('div');workspace.className='workspace';currentPanel=node('section');editorPanel=node('section');currentPanel.append(node('h2','Current access'));editorPanel.append(node('h2',s.preview?'Review proposed change':'Manage permissions'));workspace.append(currentPanel,editorPanel);content.append(workspace);
 if(s.target.role){const r=s.target.role;renderRows('Current role',[r.label+' · '+r.id,r.status+' · '+expiry(r.expiresAt),...r.rules.map(r=>ruleText(r,s))])}
 if(s.target.memberships){renderRows('Role memberships',s.target.memberships.map(m=>roleLabel(m.roleId,s)+' · '+m.status+' · '+expiry(m.expiresAt)+' ['+m.roleId+']'));renderRows('Direct grants',s.target.individual.filter(i=>i.rule.kind==='grant').map(i=>i.status+' · '+ruleText(i.rule)));renderRows('Overriding restrictions',s.target.individual.filter(i=>i.rule.kind==='restrict').map(i=>i.status+' · '+ruleText(i.rule)))}
 if(s.selection?.id===null)renderRows('New role',['No existing role. Add permissions in the editor before reviewing the proposed change.']);
 if(s.preview){const p=s.preview;const change=p.intent.change;renderRows('Proposed intent',[changeLabels[p.intent.kind],'Reason: '+p.intent.reason,...(change.label?['Role label: '+change.label]:[]),...(change.roleId?['Role: '+roleLabel(change.roleId,s)]:[]),...(change.membershipId?['Membership: '+change.membershipId]:[]),...(change.individualId?['Assignment: '+change.individualId]:[]),...(change.rules??(change.rule?[change.rule]:[])).map(r=>ruleText(r,s)),...(Object.hasOwn(change,'expiresAt')?['Expiration: '+expiry(change.expiresAt)]:[])],editorPanel);renderRows('Proposed change — supplied preview',[p.impact.summary,'Gained: '+(p.impact.gained.join('; ')||'None supplied'),'Lost: '+(p.impact.lost.join('; ')||'None supplied'),'Conflicts: '+(p.impact.conflicts.join('; ')||'None supplied'),'Assurance: '+p.requiredAssurance,'Approval: '+p.requiredApproval,'Expires: '+expiry(p.expiresAt)],editorPanel);
 const confirm=button('Explicitly confirm synthetic change',async()=>{const e=epoch;const task=controller.confirm();paint();await task;if(e===epoch)paint()});confirm.disabled=!admitted('confirmChange',{previewId:p.previewId,expectedRevision:p.intent.expectedRevision},s.context,s.target,p,s.options);confirm.className='primary';const row=node('div');row.className='action-row';row.append(confirm,button('Discard preview',()=>{controller.edit();paint()}));editorPanel.append(row);return}
 if(!s.options||s.locked||s.phase==='verified'){if(s.phase==='verified')editorPanel.append(node('p','Verified. Select the employee or role again to prepare another change.'));return;}
 const o=s.options;if(!o.allowedChanges.length||!s.context.allowedActions.includes('previewChange')||!s.target.allowedActions.includes('previewChange')){editorPanel.append(node('p','No changes are available for this record.'));return;}
 const form=node('form');form.addEventListener('submit',e=>e.preventDefault());editorPanel.append(node('p',s.selection.type==='role'?'Configure the reusable permissions in this role. Editing replaces the role rule list after confirmation.':'Assign reusable roles or manage exceptions for this employee.'),form);
 const kind=select(form,'What would you like to change?',o.allowedChanges.map(k=>[k,changeLabels[k]]));
 const fields=node('div');fields.className='editor-fields';form.append(fields);
 const reason=input(form,'Reason for this change','Synthetic role review');
 function build(){
  fields.replaceChildren();draftRules=s.target.role?.rules.map(r=>JSON.parse(JSON.stringify(r)))??[];
  const k=kind.value;let name,expires,role,member,individual,op,scope,ruleKind,ruleExpiry;
  const makeExpiry=(parent,label)=>input(parent,label,'','datetime-local');
  const readExpiry=n=>n?.value?new Date(n.value).getTime():null;
  if(k==='role.create'||k==='role.update'){name=input(fields,'Role label',s.target.role?.label??'');expires=makeExpiry(fields,'Role expiration (local time; blank = no scripted expiry)');if(s.target.role?.expiresAt!==null&&s.target.role?.expiresAt!==undefined){const d=new Date(s.target.role.expiresAt);expires.value=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}}
  if(k==='membership.add'){role=select(fields,'Role',o.roles.map(r=>[r.id,r.label+' · '+r.id]));expires=makeExpiry(fields,'Membership expiration (local time)')}
  if(k==='membership.revoke')member=select(fields,'Membership',s.target.memberships.map(m=>[m.id,roleLabel(m.roleId,s)+' · '+m.status+' ['+m.id+']']));
  if(k==='individual.revoke')individual=select(fields,'Individual assignment',s.target.individual.map(i=>[i.id,ruleText(i.rule,s)+' · '+i.status+' ['+i.id+']']));
  if(['role.create','role.update','individual.add'].includes(k)){
   const catalog=node('section');catalog.append(node('h3','Available permissions'),node('p','Choose a permission from the supplied fictional catalog. This list is not a production permission registry.'));
   fields.append(catalog);const search=input(catalog,'Search permissions by name or ID');const list=node('div');list.className='permission-list';list.setAttribute('role','group');list.setAttribute('aria-label','Available permissions');catalog.append(list);
   let selectedOp=null;scope=select(fields,'Where and what may this permission cover?',[['','Choose a permission first']]);scope.disabled=true;
   const help=node('div');help.className='scope-help';help.append(node('p','Store = where the permission applies.'),node('p','Record = the particular item or resource.'),node('p','Information = the part of that record covered.'),node('p','Only the supplied complete combinations can be selected.'));fields.append(help);
   const detail=node('p');detail.className='muted';fields.append(detail);
   const refreshScope=()=>{scope.replaceChildren();const x=o.operations.find(x=>x.id===selectedOp);const placeholder=node('option','Choose an exact scope');placeholder.value='';scope.append(placeholder);for(const [i,t] of (x?.scopes??[]).entries()){const option=node('option',friendlyScope(t));option.value=String(i);scope.append(option)}scope.disabled=!x;detail.textContent=''};
   const showScope=()=>{const x=o.operations.find(x=>x.id===selectedOp);const t=scope.value===''?null:x?.scopes[Number(scope.value)];detail.textContent=t?'Exact reference: '+[t.tenant,t.environment,t.location,t.resourceType,t.resourceId,t.field].join(' / '):''};
   scope.addEventListener('change',showScope);
   const markEdit=()=>{formVersion++;controller.edit();status.textContent=labels.editing};
   const renderCatalog=()=>{list.replaceChildren();const found=o.operations.filter(x=>(x.label+' '+x.id).toLowerCase().includes(search.value.toLowerCase()));for(const x of found){const b=button('',()=>{selectedOp=x.id;refreshScope();markEdit();for(const child of list.children)child.setAttribute('aria-pressed',String(child.dataset.operation===x.id));scope.focus()});b.dataset.operation=x.id;b.setAttribute('aria-pressed',String(selectedOp===x.id));b.append(node('strong',x.label),node('small',x.id+' · '+x.scopes.length+' supplied scope choices'));list.append(b)}if(!found.length)list.append(node('p','No matching permissions.'))};
   search.addEventListener('input',()=>{if(selectedOp&&!o.operations.some(x=>x.id===selectedOp&&(x.label+' '+x.id).toLowerCase().includes(search.value.toLowerCase()))){selectedOp=null;refreshScope()}renderCatalog()});renderCatalog();
   ruleKind=select(fields,'Access decision',[['grant','Grant — allow this permission'],['restrict','Restriction — explicitly deny this permission']]);ruleExpiry=makeExpiry(fields,'Permission expiration (local time; blank = no scripted expiry)');
   const getRule=()=>({operationId:selectedOp,scope:scope.value===''?undefined:o.operations.find(x=>x.id===selectedOp)?.scopes[Number(scope.value)],kind:ruleKind.value,expiresAt:readExpiry(ruleExpiry)});
   if(k!=='individual.add'){const draft=node('section');draft.append(node('h3','Permissions in proposed role'));const rows=node('div');rows.className='draft-list';const render=()=>{rows.replaceChildren();draftRules.forEach((r,i)=>{const row=node('div');row.className='draft-row';row.append(node('p',ruleText(r,s)),button('Remove proposed rule '+(i+1),()=>{draftRules.splice(i,1);markEdit();render()}));rows.append(row)});if(!draftRules.length)rows.append(node('p','No proposed permissions.'))};const add=button('Add selected permission to role',()=>{const r=getRule();if(!r.scope){status.textContent='Choose a permission and exact scope first.';return}if(draftRules.some(x=>x.operationId===r.operationId&&x.kind===r.kind&&JSON.stringify(x.scope)===JSON.stringify(r.scope))){status.textContent='This permission and scope are already in the proposed role.';return}draftRules.push(r);markEdit();render()});draft.append(rows,add);fields.append(draft);render()}
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
 kind.addEventListener('change',build);build();form.addEventListener('input',()=>{formVersion++;controller.edit();status.textContent=labels.editing});
 const previewButton=button('Review proposed change',async()=>{const i=fields.makeIntent();if(!validIntent(i)){status.textContent='Complete the change and choose an exact scope.';return}const e=epoch,v=++formVersion;const task=controller.requestPreview(i);status.textContent='Loading preview…';await task;if(e===epoch&&v===formVersion)paint()});previewButton.className='primary';form.append(previewButton);
}
async function open(type,id){epoch++;const e=epoch;const p=controller.open(type,id);paint();await p;if(e===epoch)paint()}
function reset(){if(controller?.snapshot().locked)return;epoch++;adapter=createMock02(scenario.value);controller=createController(adapter);open('employee','mock-e1')}
for(const s of scenarios){const o=node('option',s);o.value=s;scenario.append(o)}scenario.addEventListener('change',reset);reset();
