import { validateRestockBatch, validateRestockReasons } from './inventoryLocations.js';
// Offline transaction-plan builder only. No database, authorization, or write adapter.
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 150 && v.trim() === v;
const time = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const key = v => JSON.stringify([v.outletId,v.productId,v.variantId]);
const valid = v => v && id(v.outletId) && id(v.productId) && (v.variantId === null || id(v.variantId));
const reject = reason => ({status:'needsReview',reason,executable:false});
const plan = (operation, identity, records) => ({status:'planned',operation,identity,records,executable:false});
// Task/config/session/actor/time are trusted server inputs; request is untrusted JSON.
// Plans MUST be evaluated under transaction locks, not executed as stale preflight output.
export function planCountObservation({session,request,actorId,recordedAt}={}) {
  if (!session || !request || !id(session.sessionId) || !id(actorId) || !time(recordedAt) ||
      session.state!=='open' || !time(session.openedAt) || !id(session.outletId) ||
      !id(request.scanId) || !valid(request) || request.outletId!==session.outletId ||
      !time(request.scannedAt) || request.scannedAt<session.openedAt || request.scannedAt>recordedAt ||
      !['full-outlet','shelf','incremental'].includes(request.countMode) ||
      typeof request.countedQuantity!=='string' || !/^\d{1,12}(?:\.\d{1,6})?$/.test(request.countedQuantity) ||
      (request.countMode==='full-outlet' ? request.locationId!=null : !id(request.locationId))) return reject('count-evidence');
  const observation={sessionId:session.sessionId,scanId:request.scanId,outletId:request.outletId,productId:request.productId,variantId:request.variantId,
    countMode:request.countMode,locationId:request.locationId??null,countedQuantity:request.countedQuantity,scannedAt:request.scannedAt,recordedAt,actorId};
  return plan('count.observe',[session.sessionId,request.scanId],{observation});
}
export function planRestockConfirmation({task,request,locations,reasons,actorId,recordedAt}={}) {
  if (!task || !request || !id(task.taskId) || !id(task.version) || task.state!=='open' ||
      request.taskVersion!==task.version || !id(request.batchId) || !Array.isArray(task.lines) ||
      !Array.isArray(request.lines) || task.lines.length!==request.lines.length || !task.lines.length) return reject('task-version-or-coverage');
  const submitted=new Map(request.lines.map(l=>[l?.lineId,l]));
  if (submitted.size!==request.lines.length || new Set(task.lines.map(l=>l?.lineId)).size!==task.lines.length) return reject('duplicate-task-line');
  const lines=[];
  for (const expected of task.lines) {
    if (!valid(expected) || !id(expected.lineId)) return reject('task-line');
    const actual=submitted.get(expected.lineId);
    if (!actual || !valid(actual) || key(actual)!==key(expected) || actual.fromLocationId!==expected.fromLocationId ||
        actual.toLocationId!==expected.toLocationId || actual.plannedQuantity!==expected.plannedQuantity) return reject('task-line-mismatch');
    lines.push({...expected,movedQuantity:actual.movedQuantity,reasonCode:actual.reasonCode,note:actual.note,confirmedAt:actual.confirmedAt});
  }
  const result=validateRestockBatch({batch:{batchId:request.batchId,lines},locations,reasons,actorId,evaluatedAt:recordedAt});
  if (result.status!=='validated') return result;
  const confirmation={taskId:task.taskId,taskVersion:task.version,batchId:result.batchId,actorId,recordedAt,lines:result.lines,totalInventoryDelta:0};
  const reviews=result.reviews.map(r=>({...r,reviewId:JSON.stringify([task.taskId,r.lineId]),taskId:task.taskId,state:'open',actorId}));
  const outbox=reviews.map(r=>({eventId:r.reviewId,eventType:'inventory.review.requested',reviewId:r.reviewId}));
  return plan('restock.confirm',[task.taskId],{confirmation,reviews,outbox});
}
export function planReasonRevision({current,next,actorId,recordedAt}={}) {
  if (!id(actorId)||!time(recordedAt)||!next) return reject('reason-evidence');
  let reason;
  try { [reason]=validateRestockReasons([next]); } catch { return reject('reason-definition'); }
  if (current ? current.code!==reason.code || !Number.isSafeInteger(current.revision) || reason.revision!==current.revision+1 : reason.revision!==1) return reject('reason-revision');
  const {code,label,revision,active,requiresNote,reviewFlag,appliesTo}=reason;
  return plan('reason.revise',[code,revision],{reason:{code,label,revision,active,requiresNote,reviewFlag,appliesTo,actorId,recordedAt}});
}
