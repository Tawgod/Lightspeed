// HC-ADMIN mock v0.1.0: scripted fictional responses, not authorization.
export const VERSION = '0.1.0';
export const pages = ['employees','roles','registry','access'];
const employees = [
 {id:'mock-e1',name:'Avery Example',status:'active',location:'Mock North'},
 {id:'mock-e2',name:'Morgan Sample',status:'active',location:'Mock South'},
 {id:'mock-e3',name:'Taylor Fiction',status:'inactive',location:'Mock North'}
];
const roles = [{id:'mock-r1',label:'Sample floor role',status:'provisional',revision:'mock-rv1'},{id:'mock-r2',label:'Sample review role',status:'provisional',revision:'mock-rv2'}];
const operations = [
 ['mock-o1','View product including cost','Catalog','Product Manager','Read only; cost modification separate'],
 ['mock-o2','Modify master cost','Catalog','Product Manager','Separate field scope'],
 ['mock-o3','Modify PO line cost','Purchasing','Purchase Orders','Separate field scope'],
 ['mock-o4','Inspect invoice receipt','Purchasing','Invoice review','Local evidence; not remote reconciliation'],
 ['mock-o5','Reconcile remote PO','Purchasing','Purchase Orders','Independent reconciliation'],
 ['mock-o6','View customer contact and notes','Customer & Sales','Special Orders','Subject to individual restrictions'],
 ['mock-o7','View customer financial information','Customer & Sales','Customer lookup','Read only; scoped restrictions'],
 ['mock-o8','Confirm physical receipt','Inventory','Receiving','Not invoice approval'],
 ['mock-o9','Review delegated execution','Core','Shared tools','Separate read and execution'],
 ['mock-o10','Review employee access','Security','Administration','Independent explanation authorization']
].map(([id,label,domain,tool,description])=>({id,label,domain,tool,description,status:'provisional',scopeSchema:'Explicit synthetic location and resource',prerequisites:'Backend supplied; not an executable grant',approvalRequirements:'Not evaluated in SO-01'}));
export const scenarios=['normal','empty','denied','stale','unavailable','unsupported','invalid','authentication_required','step_up_required','approval_required','missing','error'];
let requestSequence=0;
const envelope=(status,data)=>({contractVersion:VERSION,status,requestId:'mock-request-'+(++requestSequence),policyVersion:'mock-policy-1',...(status==='ok'?{data}:{})});
function page(rows,{query='',cursor=null,limit=2}={}){
 const n=Number.isInteger(limit)&&limit>0&&limit<=20?limit:2;
 const filtered=rows.filter(r=>Object.values(r).join(' ').toLowerCase().includes(String(query).toLowerCase()));
 const offset=cursor===null?0:Number(String(cursor).replace(/^mock-page-/,''));
 if(!Number.isInteger(offset)||offset<0||offset>filtered.length||(cursor!==null&&cursor!=='mock-page-'+offset))return envelope('invalid');
 return envelope('ok',{items:filtered.slice(offset,offset+n),nextCursor:offset+n<filtered.length?'mock-page-'+(offset+n):null});
}
export function createMock(scenario='normal'){
 async function run(fn){
  await Promise.resolve();
  if(scenario==='error')throw new Error('synthetic internal failure');
  if(scenario==='unsupported')return {...envelope('ok',{}),contractVersion:'9.0.0'};
  if(scenario==='missing')return envelope('ok',{});
  if(!['normal','empty','no-explain'].includes(scenario))return envelope(scenarios.includes(scenario)?scenario:'unsupported');
  return fn();
 }
 const methods={
  getAdminContext:()=>run(()=>envelope('ok',{identityLabel:'Fictional administrator',environment:'Synthetic offline',policyVersion:'mock-policy-1',allowedNavigation:[...pages],allowedActions:scenario==='no-explain'?[]:['explainAccess'],assuranceState:'Synthetic only'})),
  searchEmployees:q=>run(()=>page(scenario==='empty'?[]:employees,q)),
  getEmployee:({employeeId})=>run(()=>{const e=employees.find(x=>x.id===employeeId);return e?envelope('ok',e):envelope('denied')}),
  listRoles:q=>run(()=>page(scenario==='empty'?[]:roles,q)),
  getRole:({roleId})=>run(()=>{const r=roles.find(x=>x.id===roleId);return r?envelope('ok',r):envelope('denied')}),
  listOperations:q=>run(()=>page(scenario==='empty'?[]:operations,q)),
  getAssignments:({employeeId})=>run(()=>employeeId==='mock-e1'?envelope('ok',{revision:'mock-av1',memberships:['Sample floor role','Sample review role'],grants:['Synthetic scoped read'],restrictions:['Synthetic South restriction']}):envelope('denied')),
  explainAccess:({employeeId,operationId,scope})=>run(()=>{
   // Exact scripted examples only. Never derive effective permissions.
   const key=JSON.stringify([employeeId,operationId,scope?.location,scope?.resource]);
   const scripts={
    '["mock-e1","mock-o1","Mock North","mock-resource-1"]':{decision:'allowed',explanation:'Scripted example: admitted read at exact scope.',sources:['Sample floor role']},
    '["mock-e1","mock-o1","Mock South","mock-resource-1"]':{decision:'denied',explanation:'Scripted example: individual restriction.',sources:['Synthetic South restriction']}
   };
   return envelope('ok',scripts[key]??{decision:'unknown',explanation:'No scripted explanation for this exact scope.',sources:[]});
  })
 };
 return {...methods,async invoke(request){
  // Mock adapter originates the response metadata; no actual HTTP contract.
  const {method,args,id,generation,policy}=request;
  const binding=JSON.stringify([method,args,generation,policy]);
  const result=await methods[method](args);
  return {binding,envelope:{...result,requestId:id}};
 }};
}
