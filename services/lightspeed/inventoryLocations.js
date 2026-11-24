// Offline domain validation only; no stock writer, DB, map dependency or permissions.
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && x.trim() === x;
const text = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 512;
const units = x => Number.isSafeInteger(x) && x >= 0;
const time = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const fail = reason => ({ status: 'needsReview', reason, executable: false });
const flags = new Set(['none','possible_shortage','possible_surplus','damage','location','allocation','manual_review']);
const productKey = x => JSON.stringify([x.outletId,x.productId,x.variantId]);
const product = x => x && id(x.outletId) && id(x.productId) && (x.variantId === null || id(x.variantId));
export function validatePhysicalLocations(locations) {
  if (!Array.isArray(locations)) throw new TypeError('Location list required');
  const ids = new Set(), codes = new Set();
  return locations.map(l => {
    if (!l || !id(l.locationId) || !id(l.outletId) || !text(l.shelfCode) || !text(l.area) ||
        !['floor','storage'].includes(l.kind) || typeof l.active !== 'boolean' ||
        (l.mapRef != null && !id(l.mapRef)) || !text(l.labelDescription)) throw new TypeError('Invalid location');
    const key = JSON.stringify([l.outletId,l.shelfCode.trim().toLowerCase()]);
    if (ids.has(l.locationId) || codes.has(key)) throw new TypeError('Duplicate location or shelf code');
    ids.add(l.locationId); codes.add(key);
    return { locationId:l.locationId, outletId:l.outletId, shelfCode:l.shelfCode, area:l.area, kind:l.kind,
      active:l.active, mapRef:l.mapRef ?? null, labelDescription:l.labelDescription, labelKind:l.kind === 'floor' ? 'floor_shelf' : 'storage_shelf' };
  });
}
// No stock value is clamped or silently inferred. Expected floor assignments must be
// furnished by a future trusted backend; even complete observations remain estimates.
export function estimateBackroom({ snapshot, floorLocationIds, locations, observations, evaluatedAt, maxAgeMs } = {}) {
  if (!product(snapshot) || snapshot.sourceSystem !== 'lightspeed-x' || snapshot.evidenceStatus !== 'verified' ||
      !time(snapshot.snapshotAsOf) || !time(evaluatedAt) || !units(maxAgeMs) ||
      Date.parse(snapshot.snapshotAsOf) > Date.parse(evaluatedAt) ||
      Date.parse(evaluatedAt)-Date.parse(snapshot.snapshotAsOf)>maxAgeMs ||
      typeof snapshot.onHand !== 'string' || !/^\d{1,15}$/.test(snapshot.onHand) || !units(Number(snapshot.onHand))) return fail('snapshot');
  if (!Array.isArray(floorLocationIds) || !floorLocationIds.length || new Set(floorLocationIds).size !== floorLocationIds.length || !Array.isArray(observations)) return fail('floor-coverage');
  let map;
  try { map = new Map(validatePhysicalLocations(locations).map(l=>[l.locationId,l])); } catch { return fail('locations'); }
  let floor=0;
  for (const locationId of floorLocationIds) {
    const l=map.get(locationId);
    const matches=observations.filter(o=>o && product(o) && productKey(o)===productKey(snapshot) && o.locationId===locationId);
    const o=matches[0];
    if (!l || !l.active || l.kind!=='floor' || l.outletId!==snapshot.outletId || matches.length!==1 ||
        !units(o.quantity) || !time(o.countedAt) || !id(o.observationId) ||
        Date.parse(o.countedAt)>Date.parse(evaluatedAt) || Date.parse(evaluatedAt)-Date.parse(o.countedAt)>maxAgeMs) return fail('floor-coverage');
    floor+=o.quantity;
    if (!units(floor)) return fail('quantity-overflow');
  }
  if (observations.some(o=>o && product(o) && productKey(o)===productKey(snapshot) && !floorLocationIds.includes(o.locationId))) return fail('unexpected-location');
  const backroom=Number(snapshot.onHand)-floor;
  if (backroom<0) return {...fail('floor-exceeds-on-hand'), discrepancyFlag:'possible_surplus', onHand:Number(snapshot.onHand), floorQuantity:floor, estimatedBackroom:null};
  return {status:'estimated', onHand:Number(snapshot.onHand), floorQuantity:floor, estimatedBackroom:backroom,
    availableToRestock:null, reconciliationRequired:true, executable:false};
}
// Registry is supplied by trusted configuration, not the employee's batch payload.
// Revisions must be retained by future persistence. No hardcoded reason codes.
export function validateRestockReasons(reasons) {
  if (!Array.isArray(reasons)) throw new TypeError('Reason registry required');
  const ids=new Set();
  return reasons.map(r=>{
    if (!r || !id(r.code) || !text(r.label) || !Number.isSafeInteger(r.revision) || r.revision<1 ||
        typeof r.active!=='boolean' || typeof r.requiresNote!=='boolean' || !flags.has(r.reviewFlag) ||
        !Array.isArray(r.appliesTo) || !r.appliesTo.length || new Set(r.appliesTo).size!==r.appliesTo.length ||
        r.appliesTo.some(x=>!['zero','partial','exact','excess'].includes(x)) || ids.has(r.code)) throw new TypeError('Invalid reason definition');
    ids.add(r.code);
    return {...r, appliesTo:[...r.appliesTo]};
  });
}
// Pure all-or-nothing validation. It does not commit or move anything. Future backend
// must supply verified actor, immutable registry revision, durable replay and atomic storage.
export function validateRestockBatch({ batch, locations, reasons, actorId, evaluatedAt } = {}) {
  if (!batch || !id(batch.batchId) || !id(actorId) || !time(evaluatedAt) || !Array.isArray(batch.lines) || !batch.lines.length || batch.lines.length>500) return fail('batch');
  let loc, registry;
  try {
    loc=new Map(validatePhysicalLocations(locations).map(l=>[l.locationId,l]));
    registry=new Map(validateRestockReasons(reasons).map(r=>[r.code,r]));
  } catch { return fail('configuration'); }
  const lines=[], reviews=[], seen=new Set(), movementKeys=new Set();
  for (const l of batch.lines) {
    if (!product(l) || !id(l.lineId) || seen.has(l.lineId) || !units(l.plannedQuantity) || !units(l.movedQuantity) ||
        !time(l.confirmedAt) || Date.parse(l.confirmedAt)>Date.parse(evaluatedAt) || !id(l.fromLocationId) || !id(l.toLocationId)) return fail('line');
    const a=loc.get(l.fromLocationId), b=loc.get(l.toLocationId);
    if (!a?.active || !b?.active || a.kind!=='storage' || b.kind!=='floor' || a.outletId!==l.outletId || b.outletId!==l.outletId) return fail('movement-location');
    const key=JSON.stringify([productKey(l),a.locationId,b.locationId]);
    if (movementKeys.has(key)) return fail('duplicate-movement');
    seen.add(l.lineId); movementKeys.add(key);
    const outcome=l.movedQuantity===0?'zero':l.movedQuantity<l.plannedQuantity?'partial':l.movedQuantity>l.plannedQuantity?'excess':'exact';
    const reason=l.reasonCode==null?null:registry.get(l.reasonCode);
    if ((outcome!=='exact' || l.reasonCode!=null) && (!reason?.active || !reason.appliesTo.includes(outcome))) return fail('reason-required-or-invalid');
    if (l.note!=null && !text(l.note)) return fail('note-invalid');
    if (reason?.requiresNote && !text(l.note)) return fail('note-required');
    const normalized={lineId:l.lineId,outletId:l.outletId,productId:l.productId,variantId:l.variantId,
      fromLocationId:a.locationId,toLocationId:b.locationId,plannedQuantity:l.plannedQuantity,movedQuantity:l.movedQuantity,
      outcome,confirmedAt:l.confirmedAt,actorId,reason:reason?{code:reason.code,label:reason.label,revision:reason.revision,reviewFlag:reason.reviewFlag}:null,note:l.note??null};
    lines.push(normalized);
    const reviewFlag=reason?.reviewFlag;
    if (reviewFlag && reviewFlag!=='none') reviews.push({batchId:batch.batchId,lineId:l.lineId,outletId:l.outletId,productId:l.productId,variantId:l.variantId,reviewFlag,
      evidenceType:'restock_observation',quantityVariance:null,reason:normalized.reason,observedAt:l.confirmedAt});
  }
  return {status:'validated',batchId:batch.batchId,actorId,lines,reviews,totalInventoryDelta:0,executable:false};
}
