import {equal,rule} from './contract.js';
// Pure presentation draft. Never evaluates access or submits changes.
export function createPermissionDraft(initial,operations){
 let draft=structuredClone(initial);
 const offered=(id,scope)=>operations.some(o=>o.id===id&&o.scopes.some(s=>equal(s,scope)));
 const index=(id,scope,kind)=>draft.findIndex(r=>r.operationId===id&&r.kind===kind&&equal(r.scope,scope));
 const find=(id,scope,kind)=>{const i=index(id,scope,kind);return i<0?null:structuredClone(draft[i])};
 return {find,has:(...a)=>index(...a)>=0,rules:()=>structuredClone(draft),unoffered:()=>structuredClone(draft.filter(r=>!offered(r.operationId,r.scope))),
 toggle(id,scope,kind,checked){if(!offered(id,scope)||!['grant','restrict'].includes(kind)||typeof checked!=='boolean')return false;const i=index(id,scope,kind);if(checked&&i<0){if(draft.length>=100)return false;draft.push({operationId:id,scope:structuredClone(scope),kind,expiresAt:null})}if(!checked&&i>=0)draft.splice(i,1);return true},
 setExpiry(id,scope,kind,expiresAt){const i=index(id,scope,kind);if(i<0||!offered(id,scope))return false;const r={...draft[i],expiresAt};if(!rule(r))return false;draft[i]=r;return true}
 }
}
