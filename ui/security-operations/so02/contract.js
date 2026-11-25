// HC-ADMIN mock 0.2.0 closed shapes; synthetic only. No authorization evaluator.
export const VERSION='0.2.0';
export const kinds=['role.create','role.update','role.retire','membership.add','membership.revoke','individual.add','individual.revoke'];
export const actions=['readRole','readAssignments','readOptions','previewChange','confirmChange','getChangeStatus','readAudit'];
const surfaces=['roles','employees','changes'],statuses=['ok','denied','authentication_required','step_up_required','approval_required','stale','unsupported','unavailable','invalid','unknown'];
export const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/.test(v);
const text=(v,n=160)=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=n;
const time=v=>Number.isSafeInteger(v)&&v>=0, bool=v=>typeof v==='boolean';
const one=(...a)=>v=>a.includes(v), nullable=f=>v=>v===null||f(v);
const obj=(v,s)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===Object.keys(s).length&&Object.entries(s).every(([k,f])=>Object.hasOwn(v,k)&&f(v[k]));
export const canonical=v=>JSON.stringify(v,undefined,0);
export const equal=(a,b)=>{if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]))};
const arr=(f,key=v=>v)=>v=>Array.isArray(v)&&v.length<=100&&v.every(f)&&v.every((x,i)=>!v.slice(0,i).some(y=>equal(key(x),key(y))));
const labels=arr(text), acts=arr(one(...actions)), env=one('mock-test'), target=one('role','employee');
export const scope=v=>obj(v,{tenant:id,environment:env,location:id,resourceType:id,resourceId:id,field:id});
export const rule=v=>obj(v,{operationId:id,scope,kind:one('grant','restrict'),expiresAt:nullable(time)});
const rules=arr(rule,v=>[v.operationId,v.scope,v.kind]);
const base={id,revision:id,status:one('active','inactive','expired','revoked'),expiresAt:nullable(time)};
const role=v=>obj(v,{...base,label:text,rules});
const membership=v=>obj(v,{...base,employeeId:id,roleId:id});
const individual=v=>obj(v,{...base,employeeId:id,rule});
const context=v=>obj(v,{identityLabel:text,tenant:id,environment:env,policyVersion:id,assuranceState:one('mock-current','mock-step-up-required'),allowedNavigation:arr(one(...surfaces)),allowedActions:acts,now:time});
const roleData=v=>obj(v,{role,allowedActions:acts});
const assignments=v=>obj(v,{employeeId:id,revision:id,memberships:arr(membership,x=>x.id),individual:arr(individual,x=>x.id),allowedActions:acts});
const optionRole=v=>obj(v,{id,label:text});
const optionOperation=v=>obj(v,{id,label:text,scopes:arr(scope)});
const options=v=>obj(v,{targetType:target,targetId:nullable(id),roles:arr(optionRole,x=>x.id),operations:arr(optionOperation,x=>x.id),allowedChanges:arr(one(...kinds))});
const roleChange=v=>obj(v,{label:text,rules,expiresAt:nullable(time)});
const changes={'role.create':roleChange,'role.update':roleChange,'role.retire':v=>obj(v,{}),'membership.add':v=>obj(v,{roleId:id,expiresAt:nullable(time)}),'membership.revoke':v=>obj(v,{membershipId:id,membershipRevision:id}),'individual.add':v=>obj(v,{rule}),'individual.revoke':v=>obj(v,{individualId:id,individualRevision:id})};
export function intent(v){return obj(v,{kind:one(...kinds),targetType:target,targetId:nullable(id),expectedRevision:nullable(id),reason:x=>text(x,250),change:x=>!!changes[v.kind]&&changes[v.kind](x)})&&(v.kind.startsWith('role.')?v.targetType==='role':v.targetType==='employee')&&(v.kind==='role.create'?v.targetId===null&&v.expectedRevision===null:id(v.targetId)&&id(v.expectedRevision))}
const preview=v=>obj(v,{previewId:id,intent,expiresAt:time,impact:x=>obj(x,{summary:text,gained:labels,lost:labels,conflicts:labels}),requiredAssurance:one('current','step-up'),requiredApproval:one('none','independent'),confirmationAllowed:bool,allowedActions:acts});
const refFields={changeId:id,targetType:target,targetId:nullable(id)};
export const changeRef=v=>obj(v,refFields)&&(v.targetType==='role'||v.targetId!==null);
const audit=v=>obj(v,{eventId:id,changeId:id,actorLabel:text,kind:one(...kinds),result:one('committed'),at:time,reason:x=>text(x,250),correlationId:id});
const result=v=>obj(v,{...refFields,outcome:one('pending-approval','committed','denied','unknown'),revision:nullable(id),policyVersion:nullable(id),audit:nullable(audit)})&&(v.targetType==='role'||v.targetId!==null)&&(v.outcome==='committed'?id(v.targetId)&&id(v.revision)&&id(v.policyVersion)&&(!v.audit||v.audit.changeId===v.changeId):v.revision===null&&v.audit===null);
const argsChecks={getAdminContext:v=>obj(v,{}),getRole:v=>obj(v,{roleId:id}),getAssignments:v=>obj(v,{employeeId:id}),getEditOptions:v=>obj(v,{targetType:target,targetId:nullable(id)})&&(v.targetType==='role'||v.targetId!==null),previewChange:v=>obj(v,{intent}),confirmChange:v=>obj(v,{previewId:id,expectedRevision:nullable(id),idempotencyKey:id,confirmed:one(true)}),getChangeStatus:v=>obj(v,{changeId:id})};
export const validRequest=v=>obj(v,{contractVersion:one(VERSION),requestId:id,method:one(...Object.keys(argsChecks)),args:x=>!!argsChecks[v.method]&&argsChecks[v.method](x),generation:time,expectedPolicyVersion:nullable(id)})&&(v.method==='getAdminContext'?v.expectedPolicyVersion===null:id(v.expectedPolicyVersion));
const validators={getAdminContext:context,getRole:roleData,getAssignments:assignments,getEditOptions:options,previewChange:preview,confirmChange:result,getChangeStatus:result};
export const binding=r=>JSON.stringify([r.method,r.args,r.generation,r.expectedPolicyVersion]);
const contains=(a,x)=>Array.isArray(a)&&a.includes(x);
const surfaceFor=t=>t==='role'?'roles':'employees';
export function admitted(method,args,c,t,p,o){
 if(method==='getAdminContext')return true;
 if(!context(c))return false;
 const has=(surface,action)=>contains(c.allowedNavigation,surface)&&contains(c.allowedActions,action);
 if(method==='getRole')return has('roles','readRole');
 if(method==='getAssignments')return has('employees','readAssignments');
 if(method==='getEditOptions')return has(surfaceFor(args.targetType),'readOptions');
 if(method==='getChangeStatus')return has('changes','getChangeStatus');
 if(method==='previewChange')return has(surfaceFor(args.intent.targetType),'previewChange')&&contains(t?.allowedActions,'previewChange')&&contains(o?.allowedChanges,args.intent.kind);
 if(method==='confirmChange')return !!p&&has(surfaceFor(p.intent.targetType),'confirmChange')&&contains(t?.allowedActions,'confirmChange')&&contains(p.allowedActions,'confirmChange')&&p.confirmationAllowed&&p.requiredAssurance==='current'&&p.requiredApproval==='none'&&p.expiresAt>c.now&&args.previewId===p.previewId&&args.expectedRevision===p.intent.expectedRevision;
 return false;
}
export function intentMatchesOptions(i,o,c,t){
 if(!intent(i)||!options(o)||!context(c)||i.targetType!==o.targetType||i.targetId!==o.targetId||!o.allowedChanges.includes(i.kind))return false;
 const rev=i.targetType==='role'?t?.role?.revision:t?.revision;
 if(i.kind!=='role.create'&&i.expectedRevision!==rev)return false;
 const rr=i.change.rules??(i.change.rule?[i.change.rule]:[]);
 if(!rr.every(r=>r.scope.tenant===c.tenant&&r.scope.environment===c.environment&&o.operations.some(op=>op.id===r.operationId&&op.scopes.some(s=>equal(s,r.scope)))))return false;
 if(i.kind==='membership.add'&&!o.roles.some(r=>r.id===i.change.roleId))return false;
 if(i.kind==='membership.revoke'&&!t?.memberships?.some(m=>m.id===i.change.membershipId&&m.revision===i.change.membershipRevision))return false;
 if(i.kind==='individual.revoke'&&!t?.individual?.some(m=>m.id===i.change.individualId&&m.revision===i.change.individualRevision))return false;
 return true;
}
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v};
let seq=0;
export async function invoke(adapter,method,args,{context:c=null,target:t=null,preview:p=null,options:o=null,generation=0,current=()=>true}={}){
 const uncertain=()=>({state:method==='confirmChange'?'unknown':'invalid'});
 try{
  if(!current(generation))return {state:'superseded'};
  const req=freeze({contractVersion:VERSION,requestId:'so02-request-'+(++seq),method,args:JSON.parse(JSON.stringify(args)),generation,expectedPolicyVersion:method==='getAdminContext'?null:c?.policyVersion});
  if(!validRequest(req)||!admitted(method,req.args,c,t,p,o))return {state:'invalid'};
  if(method==='previewChange'&&!intentMatchesOptions(req.args.intent,o,c,t))return {state:'invalid'};
  const reply=await adapter.invoke(req);
  if(!current(generation))return {state:'superseded'};
  if(!obj(reply,{binding:v=>typeof v==='string',envelope:v=>obj(v,{contractVersion:one(VERSION),requestId:id,policyVersion:nullable(id),status:one(...statuses),data:()=>true})})||reply.binding!==binding(req)||reply.envelope.requestId!==req.requestId)return uncertain();
  const e=reply.envelope,d=e.data,expected=req.expectedPolicyVersion;
  if(e.status!=='ok'){
   if(method==='confirmChange'&&e.status==='unknown'&&changeRef(d)&&p&&d.targetType===p.intent.targetType&&(p.intent.targetId===d.targetId||p.intent.kind==='role.create'))return {state:'unknown',ref:d};
   if(d!==null)return uncertain();
   return {state:e.status};
  }
  if(!validators[method](d))return uncertain();
  if(method==='getAdminContext'&&e.policyVersion!==d.policyVersion)return {state:'invalid'};
  if(method!=='getAdminContext'&&!(method==='confirmChange'&&d.outcome==='committed')&&e.policyVersion!==expected)return uncertain();
  if(method==='getRole'&&(d.role.id!==req.args.roleId||d.role.rules.some(r=>r.scope.tenant!==c.tenant||r.scope.environment!==c.environment)))return {state:'invalid'};
  if(method==='getAssignments'&&(d.employeeId!==req.args.employeeId||[...d.memberships,...d.individual].some(x=>x.employeeId!==d.employeeId)||d.individual.some(x=>x.rule.scope.tenant!==c.tenant||x.rule.scope.environment!==c.environment)))return {state:'invalid'};
  if(method==='getEditOptions'&&(d.targetType!==req.args.targetType||d.targetId!==req.args.targetId||d.operations.some(op=>op.scopes.some(s=>s.tenant!==c.tenant||s.environment!==c.environment))))return {state:'invalid'};
  if(method==='previewChange'&&(!equal(d.intent,req.args.intent)||d.expiresAt<=c.now))return {state:'invalid'};
  if(method==='getChangeStatus'&&(d.changeId!==req.args.changeId||(d.outcome!=='committed'&&![null,expected].includes(d.policyVersion))))return {state:'invalid'};
  if(method==='confirmChange'&&(d.outcome==='unknown'||!p||d.targetType!==p.intent.targetType||(p.intent.kind!=='role.create'&&d.targetId!==p.intent.targetId)||(d.outcome==='committed'?e.policyVersion!==d.policyVersion:![null,expected].includes(d.policyVersion))))return uncertain();
  if(['confirmChange','getChangeStatus'].includes(method)&&d.audit&&(!contains(c.allowedActions,'readAudit')||(method==='confirmChange'&&d.audit.kind!==p.intent.kind)))return uncertain();
  return {state:'ok',data:d};
 }catch{return current(generation)?uncertain():{state:'superseded'}}
}
