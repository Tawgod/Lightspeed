# Core Operations employee + service admission — development checkpoint (2026-11-11)

**Status: In Development / Testing. No production deployment, no activated route grants.**  
**Branch:** `Tawgod/Lightspeed:integration/security-all-tools-20261111` ([draft PR #61](https://github.com/Tawgod/Lightspeed/pull/61)).

## Implemented code, deliberately disabled

- `services/security/coreOperationsRouteAdmission.js` — factory `createCoreOperationsRouteAdmission({ approvedRoutes, staffAccess, verifyServiceRequest, checkServiceGrant })`.
- The default `approvedRoutes=[]` **denies every business operation**. The separate 87-endpoint `coreOperationsRouteInventory.js` is audit information only; its pending `operation` field is never interpreted as an authorization grant.
- Every trusted admission declaration names the **exact source file, method, route template, audience and operation**. A request must match one and only one approved declaration, and unknown, malformed or encoded paths fail closed. Template parameter matching is conservative and deliberately may reject unusual IDs until audited.
- **Employee requests:** delegate to the existing `staffAccessBaseline` / `staffSecurityBridge`, which must verify a signed, active real Timeclock employee session, independently registered workstation or current employee-bound MFA, and an exact backend operation grant. Current high-impact `special-orders.manage` requires phishing-resistant recent step-up; ordinary `special-orders.read` accepts a validated workstation or routine factor and exact grant. The admission bridge does **not** trust the existing `req.hcAuth`, role, PIN, Origin, claimed employee or legacy admin key.
- **Service requests:** require a separate trusted backend `verifyServiceRequest` (e.g. signed/revocable machine credential with audience), returning an active and typed service identity, and a separately evaluated `checkServiceGrant` for the exact `service.*` operation. A browser-supplied service ID or an old administrator key is **never** proof. These callbacks do not yet exist in the production composition; no service operation has been granted.
- `special-orders.js`: adds an **optional, backend-only** `coreOperationsAdmission` argument to `createSpecialOrdersRouter`. If omitted (as in current `server.js`), operation routing is identical to the existing source. If explicitly supplied in a reviewed staging composition, the former admin-key/Timeclock login middleware is applied **only to `/auth-check`**, while **all business requests (staff and services) go through the new guard** before any handler or nested product route. This is necessary for independently authenticated service identities to work without also carrying an obsolete static administrator key. `GET /health` and `GET /auth-check` preserve prior behavior. A malformed supplied guard causes startup failure, not an open bypass.
- `server.js` does **not** supply the guard. There is no new setting, accepted employee grant, role change, database migration or production deployment in this milestone.

## Candidate examples tested — not approved for live enforcement

| Exact route | Audience | Operation | Independent verification |
| --- | --- | --- | --- |
| `GET /orders` | Employee | `special-orders.read` | Signed active Timeclock session, registered station or valid routine MFA, exact backend read grant |
| `POST /orders` | Employee | `special-orders.manage` | Signed active Timeclock session, fresh phishing-resistant factor and exact backend write grant — **provisional; too broad for ordinary workflow changes** |
| `POST /notifications/:id/claim-discord` | Service | `service.notifications.claim-discord` | Revocable machine identity verified separately from employee sessions, exact service grant — **only simulated test identities; actual caller unverified** |

The examples are specified inside isolated test configurations and are **not** application production allowlists. The legacy admin key is currently still accepted by the *outer* Special Orders middleware for backward compatibility, but it cannot satisfy this new gate when deliberately mounted.

## Tests

- `tests/core-operations-route-admission.test.mjs` proves the empty policy denies known paths even with forged Owner claims or legacy key, routine reads require actual independent staff proof and backend grants, privileged writes reject station-only/TOTP and require strong proof, service caller grants are independent and exact, bad configurations/URLs fail closed, and HTTP middleware blocks work before handlers.
- `tests/core-operations-route-seam.test.mjs` mounts the *real* Special Orders router in isolated loopback HTTP tests. Checks legacy behavior when the optional gate is missing; verifies a supplied zero-approved gate rejects both main and nested product endpoints; preserves health/session-check; checks independently admitted staff reaches the existing DB-not-configured boundary **without** a database or Lightspeed call; invalid guard fails startup.
- `.github/workflows/security-all-tools-policy.yml` runs both with Node 22 and project dependencies, in addition to the previous shared policy, read gateway, and source drift tests. **Record the actual latest CI conclusion before claiming the new milestone tested.**

## Granular, unapproved tool permission proposals — 2026-11-11

The first round of source review found that `special-orders.manage` and `ordering.manage` were too broad: status changes can **cancel/complete an item and suppress customer notifications**, supplier PO receipt can **allocate customer inventory**, notification review can **enqueue outbound messages**, and external operations can create customers/products/POs in Lightspeed. A generic rule treating all edits as routine would be unsafe.

The new `services/security/coreOperationsProvisionalScopes.js` is a **review-only** 14-route split (all `review:'pending'`) and **is not imported by the live router or the admission gate**. The proposed exact tool operation names were added to `TOOL_OPERATIONS` with staff assurance in `staffAccessBaseline.js` for **simulated staging decisions only**. This addition **does not issue grants, alter an employee role or approve any route**.

| Proposed normal workstation + grant | Example route | Limitation |
| --- | --- | --- |
| `special-orders.notes.write` | `PATCH /items/:id/notes` | Local note and activity; authenticated actor must be server-derived before launch |
| `special-orders.routing.write` | `PATCH /items/:id/routing` | Local sourcing only, before supplier order attached |
| `ordering.draft.write` | `POST /supplier-orders` | Creates *unsent* local draft only, no Lightspeed vendor submission |

Other proposed actions explicitly demand an independent recent phishing-resistant factor **plus the exact backend grant** when authorized: `special-orders.status.write`, `special-orders.create`, `special-orders.delete`, `special-orders.notifications.send`, `preorders.allocate`, `preorders.publish`, `ordering.receive`, `ordering.vendor.push`, and `customers.lightspeed.create`. The existing `products.create` covers the nested product creation vendor write.

The status route contains both common progression and cancellation, so its candidate requires strong proof pending *request-body-sensitive* permission decisions; do not downgrade the entire endpoint based on staff convenience. All 73 other endpoints remain under pending classification (some overlap with these 14 for other methods). The 14 entries are a limited first sample, not a reviewed complete policy.

**Staging service fix:** existing router's old session gate would previously reject a valid machine credential before the new gate could run; the opt-in-only composition now skips legacy auth for all business routes **only when `coreOperationsAdmission` is explicitly present**, while retaining the old `/auth-check` flow. New HTTP test verifies a service identity can enter without an admin key and the old key alone cannot pass. No production server injects the gate. The precise actor of changes remains an issue: some handlers take `changed_by`, `reviewed_by`, or `created_by` from request data; audit identity must be server-derived before real rollout.

`tests/core-operations-provisional-scopes.test.mjs` verifies all 14 paths exist, no provisional entry automatically becomes an approval, normal vs protected proof, and exact-grant isolation. `tests/core-operations-route-seam.test.mjs` adds the service without legacy credential compatibility check. **Latest CI result must be checked separately.**

## Remaining blockers and next work

1. **Granular permissions:** `special-orders.manage` and `ordering.manage` are provisional, excessively broad write actions. Before enabling, split routine order status/notes/staging from financial adjustments, purchasing, customer-data changes, live Lightspeed writes, payment/credit, external publication, and Owner/admin operations. Do not force a passkey for every routine entry or grant broad writes to any employee by default.
2. **Caller investigation:** verify the actual service owners for 14 service/hybrid Special Orders endpoints and 2 external effects. Discord Bot and Rewards deployed source have distinct Timeclock/customer-sync and Rewards jobs; their exact calls to these specific Special Orders endpoints are not proven. Do not change existing unattended workers before auditing and testing them.
3. **Real verifiers and grants:** wire signed session binding, cryptographic station enrollment, true passkey/Authenticator proof and independently scoped machine identities from server-owned adapters; test with real employee IDs in private staging, revocation, logout, expiry and CORS/CSRF behavior. No caller-provided role may trigger a permission.
4. **Web/extension coordination:** keep the four `HCStaffAuth` web clients and Chrome Scanner Timeclock workflows compatible during staged migration. Preserve their current authenticated paths until the replacement is fully tested; extension packaging remains governed by the shared release queue.
5. **Full source reconciliation:** #33/#34/#35/#38/#51/#59/#60 draft branches, 24 direct `server.js` routes, separated Railway services and all existing functional tests. Production Timeclock-only source patch remains staged but uncommitted.
6. **Deployment:** present a separately reviewed staged service rollout with recovery and operator acceptance; no production DB/security privileges/Owner first activation until explicit approval.

This is a **reusable, default-disabled integration seam**, not a completed security cutover. The old production routing still operates under its prior authentication scheme.
