import {CORE_OPERATIONS_ROUTE_INVENTORY,coreOperationsRouteKey}
  from './coreOperationsRouteInventory.js';
import {CORE_OPERATIONS_SERVICE_PROPOSALS}
  from './coreOperationsServiceProposals.js';

// Source-observed caller classification, not permissions and not an allowlist.
// These seven entries are the remainder of the original fourteen routes marked
// service-or-automation-review. The other seven stay review-pending proposals.
// Every external HTTP caller still requires independent proof before approval.
const REVIEW = [
  {
    source:'special-orders.js',method:'POST',
    path:'/customers/:id/purchase-metrics/lightspeed-refresh',
    callerEvidence:'internal-helper-not-exposed-http',
    recommendation:'Do not issue a machine grant merely because the same helper is used by GET /preorders/products/:id/allocation-suggestions?refresh_lightspeed=1. The exposed POST has no verified external caller.',
    risk:'The allocation-suggestions GET can fetch up to 40 customers from Lightspeed and upsert local metrics; it is not side-effect-free.'
  },
  {
    source:'special-orders.js',method:'POST',
    path:'/customers/:id/purchase-metrics',
    callerEvidence:'no-http-caller-observed',
    recommendation:'Keep blocked by the future default-deny policy until a separately verified RMS importer/worker and exact source-limited grant exist.',
    risk:'Upserts customer purchase counts and spend for arbitrary non-Lightspeed source labels.'
  },
  {
    source:'special-orders.js',method:'GET',
    path:'/preorders/discord-watch',
    callerEvidence:'current-employee-browser',
    recommendation:'Classify as employee read, not service-only. Existing Preorders browser fetches the watch list.',
    risk:'Returns joined customer names, phones, email addresses, and product data.'
  },
  {
    source:'special-orders.js',method:'GET',
    path:'/notifications/delivery-queue',
    callerEvidence:'current-employee-browser',
    recommendation:'Classify as employee review read; keep distinct from service-only GET /notifications/discord-delivery.',
    risk:'Contains notification recipient, message, delivery status and customer details.'
  },
  {
    source:'special-orders.js',method:'POST',
    path:'/products/registry-upsert',
    callerEvidence:'no-http-caller-observed',
    recommendation:'No importer grant until its owner, credential and source validation are verified. Treat as mutation, not product read.',
    risk:'Upserts local product metadata and identifiers in a transaction.'
  },
  {
    source:'routes/specialOrderProducts.js',method:'POST',
    path:'/reconcile/products',
    callerEvidence:'current-employee-browser-and-internal-scheduler',
    recommendation:'Staff browser calls POST with apply:true; internal startup/12-hour schedule invokes the helper directly, not HTTP. Do not make this service-only.',
    risk:'Reconciliation can apply local product repairs; default apply:true.'
  },
  {
    source:'routes/specialOrderProducts.js',method:'POST',
    path:'/reconcile/products/:sku',
    callerEvidence:'no-http-caller-observed',
    recommendation:'Treat as high-impact local maintenance action pending a verified employee or machine owner; it always uses apply:true.',
    risk:'Per-SKU reconcile mutates local product registry and logs a reconciliation run.'
  }
];
export const CORE_OPERATIONS_REMAINING_CALLER_REVIEW = Object.freeze(
  REVIEW.map(entry=>Object.freeze({...entry,review:'pending'}))
);

export function validateRemainingCallerCoverage(){
  const candidates=CORE_OPERATIONS_ROUTE_INVENTORY.filter(route=>
    route.kind==='service-or-automation-review');
  const proposals=new Set(CORE_OPERATIONS_SERVICE_PROPOSALS.map(coreOperationsRouteKey));
  const review=new Set(CORE_OPERATIONS_REMAINING_CALLER_REVIEW.map(coreOperationsRouteKey));
  const all=new Set([...proposals,...review]);
  return Object.freeze({
    candidateCount:candidates.length,
    proposalCount:proposals.size,
    remainderCount:review.size,
    duplicateCount:proposals.size+review.size-all.size,
    missing:Object.freeze(candidates.map(coreOperationsRouteKey).filter(k=>!all.has(k))),
    extra:Object.freeze([...all].filter(k=>!candidates.some(r=>coreOperationsRouteKey(r)===k)))
  });
}
