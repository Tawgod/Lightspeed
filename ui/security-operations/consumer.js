import {VERSION,pages} from './mock.js';
const states=new Set(['denied','authentication_required','step_up_required','stale','approval_required','unsupported','unavailable','invalid']);
export const messages={loading:'Loading…',empty:'No matching records.',denied:'Access denied.',authentication_required:'Authentication required through Security.',step_up_required:'Recent strong authentication required through Security.',stale:'Data is stale. Reload before continuing.',approval_required:'Independent approval required.',unsupported:'Unsupported contract or response.',unavailable:'Service unavailable.',invalid:'Invalid response.',error:'Unable to load data.'};
const str=x=>typeof x==='string'&&x.length>0;
const strings=x=>Array.isArray(x)&&x.every(str);
export const validContext=d=>d&&['identityLabel','environment','policyVersion','assuranceState'].every(k=>str(d[k]))&&strings(d.allowedNavigation)&&strings(d.allowedActions);
export const validEmployee=d=>d&&['id','name','status','location'].every(k=>str(d[k]));
export const validRole=d=>d&&['id','label','status','revision'].every(k=>str(d[k]));
export const validOperation=d=>d&&['id','label','domain','tool','description','status','scopeSchema','prerequisites','approvalRequirements'].every(k=>str(d[k]));
export const validAssignments=d=>d&&str(d.revision)&&['memberships','grants','restrictions'].every(k=>strings(d[k]));
export const validExplanation=d=>d&&['allowed','denied','unknown'].includes(d.decision)&&str(d.explanation)&&strings(d.sources);
export const validPage=validator=>d=>d&&Array.isArray(d.items)&&d.items.every(validator)&&(d.nextCursor===null||str(d.nextCursor));
export function decode(r,validate){
 if(!r||r.contractVersion!==VERSION||!str(r.requestId))return {state:'unsupported'};
 if(r.status!=='ok')return {state:states.has(r.status)?r.status:'unsupported'};
 if(!validate(r.data))return {state:'invalid'};
 return {state:'ok',data:r.data};
}
export async function read(method,validate){try{return decode(await method(),validate)}catch{return {state:'error'}}}
export function navigation(context){return validContext(context)?pages.filter(p=>context.allowedNavigation.includes(p)):[]}
export function canExplain(context){return navigation(context).includes('access')&&context.allowedActions.includes('explainAccess')}
export function latestOnly(){let generation=0;return {start:()=>++generation,current:g=>g===generation,invalidate:()=>++generation}}

 // Local fixture transport only. Neither the snapshot nor the request ID is backend authority.
const snapshot=(method,args)=>JSON.stringify([method,args]);
let fixtureSequence=0;
export function fixtureTransport(adapter,alter=reply=>reply){
 return async (method,args,id)=>{
  const binding=snapshot(method,args);
  const envelope=await adapter[method](args);
  return alter({binding,envelope:{...envelope,requestId:id}},method);
 };
}
export async function readBound(transport,method,args,validate,policy){
 try{
  const copy=JSON.parse(JSON.stringify(args??{})),binding=snapshot(method,copy);
  if(method==='explainAccess'&&![copy.employeeId,copy.operationId,copy.scope?.location,copy.scope?.resource].every(x=>str(x)&&x.trim()))return {state:'invalid'};
  const id='local-fixture-'+(++fixtureSequence);
  const reply=await transport(method,copy,id);
  if(!reply||reply.binding!==binding||reply.envelope?.requestId!==id)return {state:'invalid'};
  const r=decode(reply.envelope,validate);
  if(r.state!=='ok')return r;
  if(policy!==undefined&&reply.envelope.policyVersion!==policy)return {state:'stale'};
  if(method==='getAdminContext'&&reply.envelope.policyVersion!==r.data.policyVersion)return {state:'stale'};
  if((method==='getEmployee'&&r.data.id!==copy.employeeId)||(method==='getRole'&&r.data.id!==copy.roleId))return {state:'invalid'};
  return r;
 }catch{return {state:'error'}}
}
