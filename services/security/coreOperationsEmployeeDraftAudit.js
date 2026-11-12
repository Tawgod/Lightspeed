import {CORE_OPERATIONS_PROVISIONAL_SCOPES}
  from './coreOperationsProvisionalScopes.js';

// DEVELOPMENT REVIEW HELPER ONLY. It does not return approvedRoutes, authorize
// requests, approve permissions, install middleware, or establish Owner consent.
// Proposal metadata can REJECT an unsafe draft, never grant live access.
const REQUIRED_FIELDS=new Set([
  'source','method','path','audience','operation',
  'statusPolicy','bodyPolicy','queryPolicy'
]);
const KEY=scope=>[scope.source,scope.method,scope.path].join(' ');
const CANDIDATES=new Map(CORE_OPERATIONS_PROVISIONAL_SCOPES.map(scope=>[KEY(scope),scope]));
const ISSUE=(index,code)=>Object.freeze({index,code});

export function auditCoreOperationsEmployeeDraft({routes}={}){
  if(!Array.isArray(routes)||routes.length>128)
    throw new TypeError('An explicit, bounded draft route array is required.');
  const issues=[],seen=new Set();
  let matchedCandidates=0;
  for(let index=0;index<routes.length;index++){
    const route=routes[index];
    if(!route||typeof route!=='object'||Array.isArray(route)){
      issues.push(ISSUE(index,'malformed-route'));continue;
    }
    if(Object.keys(route).some(key=>!REQUIRED_FIELDS.has(key))){
      issues.push(ISSUE(index,'unexpected-field'));
    }
    if(['source','method','path','audience','operation'].some(key=>
        typeof route[key]!=='string'||route[key].trim()!==route[key]||!route[key])){
      issues.push(ISSUE(index,'malformed-route'));continue;
    }
    const key=KEY(route);
    if(seen.has(key))issues.push(ISSUE(index,'duplicate-route'));
    seen.add(key);
    if(route.audience!=='employee'){
      issues.push(ISSUE(index,'non-employee-audience'));continue;
    }
    const candidate=CANDIDATES.get(key);
    if(!candidate||candidate.review!=='pending'){
      issues.push(ISSUE(index,'unreviewed-route'));continue;
    }
    matchedCandidates++;
    if(route.operation!==candidate.operation)
      issues.push(ISSUE(index,'operation-mismatch'));
    for(const field of ['statusPolicy','bodyPolicy','queryPolicy']){
      if((route[field]??null)!==(candidate[field]??null))
        issues.push(ISSUE(index,field+'-mismatch'));
    }
  }
  return Object.freeze({
    // Internal consistency is NOT owner approval or deployment readiness.
    internallyConsistent:issues.length===0&&routes.length>0,
    matchedCandidates,
    requestedRoutes:routes.length,
    candidateOnly:true,
    requiresOwnerPolicyApproval:true,
    eligibleForActivation:false,
    issues:Object.freeze(issues)
  });
}
