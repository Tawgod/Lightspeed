// Offline role expansion fixture only. No production imports, no actual assignments.
// All facts must originate from a trusted synthetic policy snapshot; never from client input.
const ident=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(v)&&v!=='unknown';
const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const fields=['operation','tenant','environment','location','resourceType','resourceId','field'];
const tuple=e=>Object.fromEntries(fields.map(k=>[k,e[k]]));
const matches=(a,b)=>fields.every(k=>a[k]===b[k]);
const live=(r,now)=>r.revoked===false&&r.startsAt<=now&&r.expiresAt>now;
const lifetime=r=>Number.isSafeInteger(r.startsAt)&&Number.isSafeInteger(r.expiresAt)&&r.expiresAt>r.startsAt&&typeof r.revoked==='boolean';
export function createSyntheticRoleEvaluator(registry){
 if(!Array.isArray(registry)||!registry.length||registry.some(v=>!ident(v))||new Set(registry).size!==registry.length)throw new TypeError('Explicit exact synthetic allowlist required');
 const ids=new Set(registry);
 const deny=reason=>({allowed:false,reason,sources:[]});
 return function evaluate({actor,effect,snapshot,now}={}){
  try{
   if(!Number.isSafeInteger(now)||!exact(actor,['realm','id','tenant','active'])||actor.realm!=='employee'||actor.active!==true||!ident(actor.id)||!ident(actor.tenant))return deny('actor');
   const validEffect=e=>exact(e,fields)&&fields.every(k=>ident(e[k]))&&ids.has(e.operation)&&e.tenant===actor.tenant&&e.environment==='test';
   if(!validEffect(effect))return deny('unknown-effect');
   if(!exact(snapshot,['tenant','environment','version','roles','assignments','individual'])||snapshot.tenant!==actor.tenant||snapshot.environment!=='test'||!ident(snapshot.version)||![snapshot.roles,snapshot.assignments,snapshot.individual].every(Array.isArray))return deny('policy');
   const validRule=r=>exact(r,['id','kind','effect','startsAt','expiresAt','revoked'])&&ident(r.id)&&['grant','restrict'].includes(r.kind)&&validEffect(r.effect)&&lifetime(r);
   const roleMap=new Map(),ruleIds=new Set();
   const recordRule=r=>{if(!validRule(r)||ruleIds.has(r.id))return false;ruleIds.add(r.id);return true;};
   for(const role of snapshot.roles){
    if(!exact(role,['id','active','rules'])||!ident(role.id)||typeof role.active!=='boolean'||roleMap.has(role.id)||!Array.isArray(role.rules)||!role.rules.every(recordRule))return deny('policy');
    roleMap.set(role.id,role);
   }
   const assignmentIds=new Set(),assignedRoles=new Set(),applicable=[];
   for(const a of snapshot.assignments){
    if(!exact(a,['id','actorId','roleId','startsAt','expiresAt','revoked'])||!ident(a.id)||a.actorId!==actor.id||!roleMap.has(a.roleId)||!lifetime(a)||assignmentIds.has(a.id))return deny('policy');
    assignmentIds.add(a.id);
    if(!live(a,now))continue;
    if(assignedRoles.has(a.roleId))return deny('policy');
    assignedRoles.add(a.roleId);
    const role=roleMap.get(a.roleId);
    if(!role.active)continue;
    for(const rule of role.rules)if(live(rule,now)&&matches(rule.effect,effect))applicable.push({kind:rule.kind,source:'role',roleId:role.id,assignmentId:a.id,ruleId:rule.id});
   }
   for(const entry of snapshot.individual){
    if(!exact(entry,['actorId','rule'])||entry.actorId!==actor.id||!recordRule(entry.rule))return deny('policy');
    const rule=entry.rule;
    if(live(rule,now)&&matches(rule.effect,effect))applicable.push({kind:rule.kind,source:'individual',ruleId:rule.id});
   }
   const sources=applicable.sort((a,b)=>a.ruleId<b.ruleId?-1:a.ruleId>b.ruleId?1:0);
   if(sources.some(s=>s.kind==='restrict'))return {allowed:false,reason:'restriction',sources,policyVersion:snapshot.version};
   if(!sources.some(s=>s.kind==='grant'))return deny('missing-grant');
   // Permission result alone is not authentication, approval or execution authority.
   return {allowed:true,reason:'synthetic-grant',sources,policyVersion:snapshot.version,effect:tuple(effect)};
  }catch{return deny('indeterminate');}
 };
}
