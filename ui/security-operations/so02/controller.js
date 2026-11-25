// UI lifecycle only. No permission evaluator; all decisions supplied by adapter.
import {invoke,equal,admitted,changeRef} from './contract.js';
export function createController(adapter){
 let generation=0, context=null,target=null,options=null,preview=null,selection=null,locked=false,ref=null,reported=null,phase='idle',serial=0;
 const current=g=>g===generation;
 const snapshot=()=>({context,target,options,preview,selection,locked,ref,reported,phase});
 const clear=()=>{target=null;options=null;preview=null;context=null};
 function invalidate(){generation++;preview=null;target=null;options=null;context=null;selection=null;phase=locked?'unknown':'idle'}
 function edit(){generation++;preview=null;phase=locked?'unknown':'editing'}
 async function call(method,args,g){return invoke(adapter,method,args,{context,target,options,preview,generation:g,current})}
 async function bootstrap(g){const r=await call('getAdminContext',{},g);if(!current(g))return false;if(r.state!=='ok'){clear();phase=r.state;return false}context=r.data;return true}
 async function initialize(){if(locked)return snapshot();const g=++generation;clear();selection=null;phase='loading';if(await bootstrap(g)&&current(g))phase='idle';return snapshot()}
 async function open(type,id){
  if(locked)return snapshot();const g=++generation;clear();selection={type,id};phase='loading';
  if(!await bootstrap(g)||!current(g))return snapshot();
  if(id===null&&type==='role')target={allowedActions:[...context.allowedActions]};
  else{const r=await call(type==='role'?'getRole':'getAssignments',type==='role'?{roleId:id}:{employeeId:id},g);if(!current(g))return snapshot();if(r.state!=='ok'){clear();phase=r.state;return snapshot()}target=r.data}
  const o=await call('getEditOptions',{targetType:type,targetId:id},g);if(!current(g))return snapshot();if(o.state!=='ok'){clear();phase=o.state;return snapshot()}options=o.data;if(type==='role'&&id!==null&&target.role.rules.some(r=>!options.operations.some(op=>op.id===r.operationId&&op.scopes.some(s=>equal(s,r.scope)))))options={...options,allowedChanges:options.allowedChanges.filter(k=>k!=='role.update')};phase=locked?'unknown':'editing';return snapshot()
 }
 async function requestPreview(intent){
  if(locked||!context||!target||!options)return snapshot();
  const g=++generation;preview=null;phase='loading';const r=await call('previewChange',{intent},g);
  if(!current(g))return snapshot();if(r.state!=='ok'){clear();phase=r.state;return snapshot()}preview=r.data;phase='preview';return snapshot()
 }
 async function readback(result,g){
  reported={outcome:'committed',verified:false};clear();phase='readback-unverified';
  if(!await bootstrap(g)||!current(g)){if(current(g))phase='readback-unverified';return}
  const a=result.targetType==='role'?{roleId:result.targetId}:{employeeId:result.targetId};
  const r=await call(result.targetType==='role'?'getRole':'getAssignments',a,g);
  if(!current(g))return;
  const rev=result.targetType==='role'?r.data?.role?.revision:r.data?.revision;
  if(r.state==='ok'&&rev===result.revision){target=r.data;selection={type:result.targetType,id:result.targetId};reported={outcome:'committed',verified:true};phase='verified';locked=false}
  else{clear();phase='readback-unverified'}
 }
 async function confirm(){
  if(locked||!preview||!context)return snapshot();
  const args={previewId:preview.previewId,expectedRevision:preview.intent.expectedRevision,idempotencyKey:'so02-key-'+(++serial),confirmed:true};
  if(!admitted('confirmChange',args,context,target,preview,options))return snapshot();
  const g=++generation;locked=true;phase='confirming';ref=null;reported=null;
  const pending=call('confirmChange',args,g);clear();
  const r=await pending;
  if(!current(g))return snapshot();
  preview=null;
  if(r.state==='ok'){
   const d=r.data;ref={changeId:d.changeId,targetType:d.targetType,targetId:d.targetId};
   if(d.outcome==='committed')await readback(d,g);
   else{clear();phase=d.outcome;locked=d.outcome!=='denied'}
  }else{ref=r.ref??null;clear();phase=r.state;locked=!['stale','denied','authentication_required','step_up_required','approval_required'].includes(r.state)}
  return snapshot()
 }
 async function inspect(){
  if(!changeRef(ref))return snapshot();
  const g=++generation;clear();phase='loading';
  if(!await bootstrap(g)||!current(g)){if(current(g)&&reported?.outcome==='committed')phase='readback-unverified';return snapshot()}
  const r=await call('getChangeStatus',{changeId:ref.changeId},g);
  if(!current(g))return snapshot();
  if(r.state!=='ok'){clear();phase=reported?.outcome==='committed'?'readback-unverified':r.state;return snapshot()}
  const d=r.data;
  if(d.targetType!==ref.targetType||(ref.targetId!==null&&d.targetId!==ref.targetId)){clear();phase=reported?.outcome==='committed'?'readback-unverified':'invalid';return snapshot()}
  if(reported?.outcome==='committed'&&d.outcome!=='committed'){clear();phase='readback-unverified';locked=true;return snapshot()}
  if(d.outcome==='committed')await readback(d,g);
  else{clear();phase=d.outcome;locked=d.outcome!=='denied'}
  return snapshot()
 }
 return {snapshot,initialize,open,edit,invalidate,requestPreview,confirm,inspect}
}
