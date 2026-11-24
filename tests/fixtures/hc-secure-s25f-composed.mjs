// Offline composition only. Trusted fixture adapters, not an application API.
import {createSyntheticDecisionContractD} from './hc-secure-s25d-decision.mjs';
import {createSyntheticRoleEvaluator} from './hc-secure-s25e-role-policy.mjs';
const deny=reason=>Object.freeze({allowed:false,reason});
const copy=x=>structuredClone(x);
const ident=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,150}$/.test(x)&&x!=='unknown';
export function createSyntheticComposedDecision({registry,readState,readPolicyVersion,clock}={}){
 if(!Array.isArray(registry)||![readState,readPolicyVersion,clock].every(f=>typeof f==='function'))throw new TypeError('Explicit fixture adapters required');
 const definitions=copy(registry);
 const evaluate=createSyntheticRoleEvaluator(definitions.map(r=>r.operation));
 return async function decide(request){
  try{
   const now=clock();if(!Number.isSafeInteger(now))return deny('clock');
   const q=copy(request);
   let failure=null,version=null;
   const decision=createSyntheticDecisionContractD({registry:definitions,clock:()=>now,readState:async immutable=>{
    const s=copy(await readState(immutable));
    if(!s||!ident(s.policyVersion)||s.policyVersion!==s.policy?.version||s.policyVersion!==await readPolicyVersion(immutable.tenant)){failure='stale-policy';throw Error('fixture');}
    version=s.policyVersion;
    const grants=[],restrictions=[];
    for(const effect of [...immutable.executionEffects,...immutable.accessEffects]){
     const result=evaluate({actor:{...immutable.actor,active:s.actorActive},effect,snapshot:s.policy,now});
     if(!result.allowed){failure=result.reason;throw Error('fixture');}
     if(result.policyVersion!==version){failure='stale-policy';throw Error('fixture');}
     // This grant is derived from the current exact role evaluation, usable only in this invocation.
     grants.push({actorId:immutable.actor.id,effect,expiresAt:now+1,revoked:false});
    }
    return {policyVersion:version,actorActive:s.actorActive,session:s.session,approval:s.approval,grants,restrictions};
   }});
   const result=await decision(q);
   if(failure)return deny(failure);
   if(!result.allowed)return deny(result.reason);
   if(!Number.isSafeInteger(clock())||clock()!==now||version!==await readPolicyVersion(q.tenant))return deny('stale-policy');
   // No role IDs, source explanations, session or approval details in ordinary decisions.
   return result;
  }catch{return deny('indeterminate');}
 };
}
// Separate read-only administrative explanation fixture. Strong assurance max is injected
// synthetic policy, not a selected production duration. Same tenant, exact target/effect.
export function createSyntheticExplanation({operations,readAdminState,readTargetState,readPolicyVersion,clock,strongMaxMs}={}){
 if(!Array.isArray(operations)||![readAdminState,readTargetState,readPolicyVersion,clock].every(f=>typeof f==='function')||!Number.isSafeInteger(strongMaxMs)||strongMaxMs<=0)throw new TypeError('Explicit fixture policy required');
 const evaluate=createSyntheticRoleEvaluator([...operations,'security.permissions.explain']);
 return async function explain({actor,sessionId,targetId,effect}={}){
  try{
   const now=clock();if(!Number.isSafeInteger(now)||!actor||actor.realm!=='employee'||!ident(actor.id)||!ident(actor.tenant)||!ident(sessionId)||!ident(targetId)||!effect||effect.tenant!==actor.tenant||effect.environment!=='test')return deny('invalid-request');
   const q=copy({actor,sessionId,targetId,effect});
   const s=copy(await readAdminState(q));
   const session=s?.session;
   if(!s||s.actorActive!==true||!session||session.id!==q.sessionId||session.actorId!==q.actor.id||session.tenant!==q.actor.tenant||session.active!==true||session.revoked!==false||session.locked!==false||session.deviceVerified!==true||!Number.isSafeInteger(session.expiresAt)||session.expiresAt<=now||!Number.isSafeInteger(session.strongAt)||session.strongAt>now||now-session.strongAt>=strongMaxMs)return deny('assurance');
   const version=await readPolicyVersion(q.actor.tenant);
   if(!ident(version)||s.policy?.version!==version)return deny('stale-policy');
   const access={operation:'security.permissions.explain',tenant:q.actor.tenant,environment:'test',location:q.effect.location,resourceType:'employee',resourceId:q.targetId,field:'effective-access'};
   const permitted=evaluate({actor:{realm:'employee',id:q.actor.id,tenant:q.actor.tenant,active:true},effect:access,snapshot:s.policy,now});
   if(!permitted.allowed)return deny('explanation-forbidden');
   const target=copy(await readTargetState(q));
   if(!target||target.policy?.version!==version||target.actor?.id!==q.targetId||target.actor?.tenant!==q.actor.tenant||target.actor?.realm!=='employee')return deny('target');
   const result=evaluate({actor:target.actor,effect:q.effect,snapshot:target.policy,now});
   if(clock()!==now||version!==await readPolicyVersion(q.actor.tenant))return deny('stale-policy');
   if(!['synthetic-grant','restriction','missing-grant','actor'].includes(result.reason))return deny('target');
   return {allowed:true,reason:'synthetic-explanation',policyVersion:version,effective:{allowed:result.allowed,reason:result.reason,sources:result.sources}};
  }catch{return deny('indeterminate');}
 };
}
