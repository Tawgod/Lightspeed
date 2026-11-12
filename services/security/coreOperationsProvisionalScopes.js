import { TOOL_OPERATIONS } from './adminPermissionCatalog.js';
import { CORE_OPERATIONS_ROUTE_INVENTORY, coreOperationsRouteKey } from './coreOperationsRouteInventory.js';

// PROPOSAL ONLY. These scopes are NOT accepted owner policy, NOT backend
// permission grants, and NEVER automatically loaded into route admission.
// Actual per-route authorization requires a separately supplied server-owned
// approvedRoutes list, independent signed employee proof, and exact grant.
// Other existing endpoints remain awaiting owner, service-owner and data-flow
// audit: do not derive authorization from HTTP verb or method.
const PROPOSALS = [
  Object.freeze({"source":"special-orders.js","method":"PATCH","path":"/items/:id/notes","operation":"special-orders.notes.write","assurance":"staff-device","rationale":"Routine local note change, with server-verified actor audit required","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"PATCH","path":"/items/:id/routing","operation":"special-orders.routing.write","assurance":"staff-device","rationale":"Local sourcing route before supplier order attachment, with actor audit","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"POST","path":"/supplier-orders","operation":"ordering.draft.write","assurance":"staff-device","rationale":"Create local unsent supplier order draft; no vendor submission","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"POST","path":"/supplier-orders/:id/items","operation":"ordering.draft.write","assurance":"staff-device","rationale":"Add lines only to an existing DRAFT supplier order; handler locks the parent row FOR UPDATE and rechecks DRAFT before inserting","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"GET","path":"/suppliers","operation":"ordering.suppliers.sync","assurance":"staff-device","rationale":"This GET reads live Lightspeed suppliers and upserts the local supplier cache; generic ordering.read must not authorize its mutation","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"GET","path":"/products/:id/recommended-suppliers","operation":"ordering.suppliers.sync","assurance":"staff-device","rationale":"Supplier recommendations call the same live supplier refresh/upsert before ranking local history, so products.read alone is insufficient","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"GET","path":"/ordering/lightspeed-context","operation":"ordering.context.refresh","assurance":"staff-device","rationale":"Loads live supplier, purchase-order, fulfillment and sale context while refreshing the local supplier cache; keep separate from generic ordering.read","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"PATCH","path":"/items/:id/status","operation":"special-orders.status.write","assurance":"step-up","rationale":"Can mark ordered/received/held/notified/complete/cancel and suppress notifications; statusPolicy locked-transition-v1 proposes separate low-impact target progression with locked current-state validation","review":"pending","statusPolicy":"locked-transition-v1"}),
  Object.freeze({"source":"special-orders.js","method":"POST","path":"/orders","operation":"special-orders.create","assurance":"step-up","rationale":"Creates order and customer data; potential initial ORDERED status","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"DELETE","path":"/items/:id","operation":"special-orders.delete","assurance":"step-up","rationale":"Deletes line with downstream references to review","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"POST","path":"/preorders/products/:id/allocate","operation":"preorders.allocate","assurance":"step-up","rationale":"Reserves customer inventory allocations","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"POST","path":"/preorders/gw/campaigns/:id/discord-publish","operation":"preorders.publish","assurance":"step-up","rationale":"External multi-message Discord publication","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"POST","path":"/supplier-orders/:id/receive","operation":"ordering.receive","assurance":"step-up","rationale":"Physical receiving and local inventory/order changes","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"POST","path":"/ordering/lightspeed-purchase-orders/:id/receive-special-orders","operation":"ordering.receive","assurance":"step-up","rationale":"Allocates received Lightspeed PO items to customer orders","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"POST","path":"/supplier-orders/:id/push-lightspeed","operation":"ordering.vendor.push","assurance":"step-up","rationale":"Writes supplier PO to live Lightspeed, needs idempotency and readback","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"POST","path":"/customers/create-lightspeed","operation":"customers.lightspeed.create","assurance":"step-up","rationale":"Creates PII-bearing Lightspeed customer, needs audit and dedupe","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"PATCH","path":"/customers/:lightspeedId/profile","operation":"customers.profile.write","assurance":"staff-device","rationale":"Local contact/profile edits are routine, but sync_lightspeed=true performs a live vendor PUT and must dynamically require customers.lightspeed.update","review":"pending","bodyPolicy":"customer-profile-sync-v1"}),
  Object.freeze({"source":"routes/specialOrderProducts.js","method":"POST","path":"/products/create-lightspeed","operation":"products.create","assurance":"step-up","rationale":"Creates live Lightspeed product, existing product-create permission","review":"pending"}),
  Object.freeze({"source":"special-orders.js","method":"PATCH","path":"/notifications/:id/review","operation":"special-orders.notifications.send","assurance":"step-up","rationale":"Acknowledgement queues outbound customer notification","review":"pending"}),
];
export const CORE_OPERATIONS_PROVISIONAL_SCOPES = Object.freeze(PROPOSALS);

// A source-consistency helper only: never returns an authorization result.
export function reviewProvisionalScopes() {
  const existing = new Set(CORE_OPERATIONS_ROUTE_INVENTORY.map(coreOperationsRouteKey));
  return Object.freeze(CORE_OPERATIONS_PROVISIONAL_SCOPES.map(scope => Object.freeze({
    ...scope,
    routePresent: existing.has(coreOperationsRouteKey(scope)),
    knownToolOperation: TOOL_OPERATIONS.includes(scope.operation)
  })));
}
