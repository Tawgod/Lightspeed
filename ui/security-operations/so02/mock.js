// Scripted, in-memory fictional records; never evaluates actual access.
import {VERSION,validRequest,binding,equal,kinds,actions,intentMatchesOptions} from './contract.js';
export const scenarios=['normal','step-up','approval','pending-approval','unknown','unknown-no-ref','denied-readback','expired-preview','revision-conflict','policy-change','denied','malformed','throw','missing-capability','delayed','filtered-role','no-read','bootstrap-denied','precise-expiry'];
const clone=v=>JSON.parse(JSON.stringify(v));
const tuple={tenant:'mock-hc',environment:'mock-test',location:'mock-north',resourceType:'product',resourceId:'mock-p1',field:'cost'};
const rule={operationId:'mock-o1',scope:tuple,kind:'grant',expiresAt:null};
const record=(id,revision,status='active',expiresAt=null)=>({id,revision,status,expiresAt});
export function createMock02(scenario='normal'){
 let now=1800000000000,policy='mock-policy-1',seq=0,commits=0,statusAllowed=true;
 const next=prefix=>'mock-'+prefix+'-'+(++seq);
 const roles=new Map([['mock-r1',{...record('mock-r1','mock-rv1'),label:'Sample floor role',rules:[clone(rule)]}],['mock-r2',{...record('mock-r2','mock-rv2'),label:'Sample review role',rules:[]}]]);
 const employees=new Map([['mock-e1',{employeeId:'mock-e1',revision:'mock-av1',memberships:[{...record('mock-m1','mock-mv1'),employeeId:'mock-e1',roleId:'mock-r1'}],individual:[{...record('mock-i1','mock-iv1','expired',now-1000),employeeId:'mock-e1',rule:{...clone(rule),expiresAt:now-1000}}]}]]);
 const previews=new Map(),results=new Map(),keys=new Map(),seen=new Set(),uncertainTargets=new Set();
 if(scenario==='precise-expiry')roles.get('mock-r1').expiresAt=now+1234567;
 if(scenario==='filtered-role')roles.get('mock-r1').rules.push({...clone(rule),scope:{...tuple,field:'hidden-fixture'}});
 const allowed=()=> (scenario==='missing-capability'?['readRole','readAssignments','readOptions']:scenario==='no-read'?[]:actions.filter(x=>x!=='readAudit')).filter(x=>statusAllowed||x!=='getChangeStatus');
 const projected=r=>({...clone(r),status:r.status==='active'&&r.expiresAt!==null&&r.expiresAt<=now?'expired':r.status});
 const ctx=()=>({identityLabel:'Fictional administrator',tenant:'mock-hc',environment:'mock-test',policyVersion:policy,assuranceState:scenario==='step-up'?'mock-step-up-required':'mock-current',allowedNavigation:['roles','employees','changes'],allowedActions:allowed(),now});
 const target=(type,id)=>type==='role'?(roles.has(id)?{role:{...projected(roles.get(id)),rules:clone(roles.get(id).rules.filter(r=>scenario!=='filtered-role'||r.scope.field!=='hidden-fixture'))},allowedActions:allowed()}:null):(employees.has(id)?{...clone(employees.get(id)),memberships:employees.get(id).memberships.map(projected),individual:employees.get(id).individual.map(projected),allowedActions:allowed()}:null);
 const opts=(type,id)=>({targetType:type,targetId:id,roles:[...roles.values()].filter(r=>projected(r).status==='active').map(({id,label})=>({id,label})),operations:[{id:'mock-o1',label:'View product including cost',scopes:[clone(tuple),{...tuple,location:'mock-south',resourceId:'mock-p2'}]},{id:'mock-o2',label:'View product description',scopes:[{...tuple,field:'description'},{...tuple,location:'mock-south',resourceId:'mock-p2',field:'description'}]},{id:'mock-o3',label:'Edit product description',scopes:[{...tuple,field:'description'}]}],allowedChanges:!allowed().includes('previewChange')?[]:type==='role'?(id===null?['role.create']:roles.has(id)&&projected(roles.get(id)).status==='active'?(scenario==='filtered-role'&&id==='mock-r1'?['role.retire']:['role.update','role.retire']):[]):kinds.filter(k=>!k.startsWith('role.'))});
 const rev=(type,id)=>type==='role'?roles.get(id)?.revision:employees.get(id)?.revision;
 const response=(req,status,data=null,p=policy)=>({binding:binding(req),envelope:{contractVersion:VERSION,requestId:req.requestId,policyVersion:p,status,data:clone(data)}});
 const denied=req=>response(req,'denied');
 function apply(i){
  const targetId=i.targetId??next('role'),revision=next('revision'),ch=i.change;
  if(i.kind==='role.create')roles.set(targetId,{...record(targetId,revision,'active',ch.expiresAt),label:ch.label,rules:clone(ch.rules)});
  else if(i.kind==='role.update')roles.set(targetId,{...roles.get(targetId),revision,...clone(ch)});
  else if(i.kind==='role.retire')roles.set(targetId,{...roles.get(targetId),revision,status:'revoked'});
  else{
   const e=employees.get(targetId);e.revision=revision;
   if(i.kind==='membership.add')e.memberships.push({...record(next('membership'),next('revision'),'active',ch.expiresAt),employeeId:targetId,roleId:ch.roleId});
   if(i.kind==='membership.revoke'){const m=e.memberships.find(x=>x.id===ch.membershipId);m.status='revoked';m.revision=next('revision')}
   if(i.kind==='individual.add')e.individual.push({...record(next('individual'),next('revision'),'active',ch.rule.expiresAt),employeeId:targetId,rule:clone(ch.rule)});
   if(i.kind==='individual.revoke'){const m=e.individual.find(x=>x.id===ch.individualId);m.status='revoked';m.revision=next('revision')}
  }
  commits++;policy=next('policy');
  return {changeId:next('change'),targetType:i.targetType,targetId,outcome:'committed',revision,policyVersion:policy,audit:null};
 }
 function noncommit(i,outcome){return {changeId:next('change'),targetType:i.targetType,targetId:i.targetId,outcome,revision:null,policyVersion:policy,audit:null}}
 return {advance(ms){now+=ms},revokeStatus(){statusAllowed=false},advancePolicy(){policy=next('policy')},inspect(){return {commits,policy,now}},async invoke(req){
  if(!validRequest(req)||seen.has(req.requestId))return response(req,'invalid');
  seen.add(req.requestId);
  const {method,args,expectedPolicyVersion}=req;
  if(scenario==='delayed')await new Promise(r=>setTimeout(r,method==='previewChange'?500:30));
  if(method==='getAdminContext')return scenario==='bootstrap-denied'?denied(req):response(req,'ok',ctx());
  if(method==='confirmChange'&&keys.has(args.idempotencyKey)){
   const replay=keys.get(args.idempotencyKey);
   if(!allowed().includes('getChangeStatus')||!allowed().includes(replay.targetType==='role'?'readRole':'readAssignments'))return denied(req);
   return equal(replay.args,args)&&replay.originalPolicy===expectedPolicyVersion?response(req,replay.status,replay.data,replay.policy):response(req,'stale');
  }
  if(expectedPolicyVersion!==policy)return response(req,'stale');
  if(method==='getRole'||method==='getAssignments'){
   if(scenario==='denied-readback'&&commits)return denied(req);
   const action=method==='getRole'?'readRole':'readAssignments';if(!allowed().includes(action))return denied(req);
   const t=target(method==='getRole'?'role':'employee',args.roleId??args.employeeId);return t?response(req,'ok',t):denied(req)
  }
  if(method==='getEditOptions'){if(!allowed().includes('readOptions')||(args.targetId!==null&&!target(args.targetType,args.targetId)))return denied(req);return response(req,'ok',opts(args.targetType,args.targetId))}
  if(method==='previewChange'){
   const i=args.intent,t=i.targetId===null?{allowedActions:allowed()}:target(i.targetType,i.targetId),o=opts(i.targetType,i.targetId);
   if(!t||!allowed().includes('previewChange')||!intentMatchesOptions(i,o,ctx(),t))return denied(req);
   if(uncertainTargets.has(JSON.stringify([i.targetType,i.targetId])))return response(req,'stale');
   if(i.kind==='membership.add'&&t.memberships.some(x=>x.roleId===i.change.roleId&&x.status==='active'))return response(req,'invalid');
   if(scenario==='denied')return denied(req);
   const p={previewId:next('preview'),intent:clone(i),expiresAt:now+60000,impact:{summary:'Scripted change',gained:i.kind==='membership.add'?['Scripted role membership addition']:[],lost:i.kind==='role.retire'?['Scripted role retirement impact']:[],conflicts:[]},requiredAssurance:scenario==='step-up'?'step-up':'current',requiredApproval:scenario==='approval'?'independent':'none',confirmationAllowed:!['step-up','approval'].includes(scenario),allowedActions:['confirmChange']};
   previews.set(p.previewId,{preview:clone(p),policy,used:false});
   if(scenario==='expired-preview')now=p.expiresAt;
   return response(req,'ok',p);
  }
  if(method==='getChangeStatus'){if(!allowed().includes('getChangeStatus'))return denied(req);const r=results.get(args.changeId);return r?response(req,'ok',r):denied(req)}
  if(method==='confirmChange'){
   if(!allowed().includes('confirmChange'))return denied(req);
   const entry=previews.get(args.previewId);if(!entry)return denied(req);
   const p=entry.preview,i=p.intent;
   if(uncertainTargets.has(JSON.stringify([i.targetType,i.targetId]))||entry.used||!p.confirmationAllowed||entry.policy!==policy||now>=p.expiresAt||args.expectedRevision!==i.expectedRevision||(i.targetId!==null&&rev(i.targetType,i.targetId)!==i.expectedRevision)||scenario==='revision-conflict')return response(req,'stale');
   if(scenario==='policy-change'){policy=next('policy');return response(req,'stale')}
   entry.used=true;
   let status='ok',data;
   if(scenario==='pending-approval'){data=noncommit(i,'pending-approval');uncertainTargets.add(JSON.stringify([i.targetType,i.targetId]))}
   else if(['unknown','unknown-no-ref','throw','malformed'].includes(scenario)){
    const r=noncommit(i,'unknown');uncertainTargets.add(JSON.stringify([i.targetType,i.targetId]));results.set(r.changeId,r);status='unknown';data=scenario==='unknown-no-ref'?null:{changeId:r.changeId,targetType:r.targetType,targetId:r.targetId};
   }else data=apply(i);
   if(status==='ok')results.set(data.changeId,data);
   keys.set(args.idempotencyKey,{args:clone(args),originalPolicy:expectedPolicyVersion,targetType:i.targetType,status,data:clone(data),policy});
   if(scenario==='throw')throw Error('fictional transport failure');
   if(scenario==='malformed')return response(req,'ok',{unexpected:'hidden fictional payload'});
   return response(req,status,data)
  }
  return response(req,'unsupported')
 }};
}
