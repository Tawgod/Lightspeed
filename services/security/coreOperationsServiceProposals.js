import {CORE_OPERATIONS_ROUTE_INVENTORY,coreOperationsRouteKey}
  from './coreOperationsRouteInventory.js';

// REVIEW-PENDING SERVICE PROPOSALS ONLY.
//
// These declarations document source-observed machine/worker callback shapes.
// They are NOT imported by server.js, NOT loaded by the route admission
// factory, and do not create credentials or grants. A production service
// caller still needs a separately verified revocable machine identity and an
// exact backend service.* grant before one of these routes can be approved.
//
// Mixed employee/browser routes such as GET /preorders/discord-watch,
// GET /notifications/delivery-queue, and POST /reconcile/products are
// intentionally excluded.
const PROPOSALS = [
  Object.freeze({
    source:'special-orders.js',method:'POST',path:'/preorders/discord-watch',
    audience:'service',operation:'service.preorders.discord-watch.capture',
    rationale:'Discord ingestion callback captures or updates a preorder-watch item from message metadata.',
    review:'pending'
  }),
  Object.freeze({
    source:'special-orders.js',method:'POST',path:'/preorders/gw/discord-reaction',
    audience:'service',operation:'service.preorders.gw.discord-reaction',
    rationale:'Discord reaction callback can create/cancel preorder requests and stage customer confirmation notifications.',
    review:'pending'
  }),
  Object.freeze({
    source:'special-orders.js',method:'POST',path:'/preorders/gw/campaigns/:id/auto-submit-failure',
    audience:'service',operation:'service.preorders.gw.auto-submit-failure',
    rationale:'Automation failure callback emits a GW submission failure alert and is not a normal employee form action.',
    review:'pending'
  }),
  Object.freeze({
    source:'special-orders.js',method:'POST',path:'/preorders/gw/campaigns/:id/mark-submitted',
    audience:'service',operation:'service.preorders.gw.mark-submitted',
    rationale:'Submission worker callback records a completed external GW submission and its campaign-side effects.',
    review:'pending'
  }),
  Object.freeze({
    source:'special-orders.js',method:'GET',path:'/notifications/discord-delivery',
    audience:'service',operation:'service.notifications.discord-delivery.read',
    rationale:'Delivery worker reads only queued Discord-ready notifications eligible for machine dispatch.',
    review:'pending'
  }),
  Object.freeze({
    source:'special-orders.js',method:'POST',path:'/notifications/:id/claim-discord',
    audience:'service',operation:'service.notifications.claim-discord',
    rationale:'Delivery worker atomically claims one queued Discord notification by moving it to SENDING.',
    review:'pending'
  }),
  Object.freeze({
    source:'special-orders.js',method:'POST',path:'/notifications/:id/complete-discord',
    audience:'service',operation:'service.notifications.complete-discord',
    rationale:'Delivery worker records Discord send success/failure and can atomically advance the Special Order to CUSTOMER_NOTIFIED.',
    review:'pending'
  })
];

export const CORE_OPERATIONS_SERVICE_PROPOSALS = Object.freeze(PROPOSALS);

export function reviewCoreOperationsServiceProposals(){
  const inventory=new Map(CORE_OPERATIONS_ROUTE_INVENTORY.map(route=>[
    coreOperationsRouteKey(route),route
  ]));
  return Object.freeze(CORE_OPERATIONS_SERVICE_PROPOSALS.map(route=>{
    const existing=inventory.get(coreOperationsRouteKey(route));
    return Object.freeze({
      ...route,
      routePresent:Boolean(existing),
      inventoryKind:existing?.kind||null,
      inventoryCaller:existing?.caller||null
    });
  }));
}
