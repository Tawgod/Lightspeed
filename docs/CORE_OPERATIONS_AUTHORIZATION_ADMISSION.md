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

The status route handles both everyday progression and consequential cancellation. A proposed `locked-transition-v1` request-target classification plus database-locked prior-state check is now implemented but **unapproved and unmounted**; see the dedicated status-transition section below. All 73 other endpoints remain under pending classification (some overlap with these 14 for other methods). The 14 entries are a limited first sample, not a reviewed complete policy.

**Staging service fix:** existing router's old session gate would previously reject a valid machine credential before the new gate could run; the opt-in-only composition now skips legacy auth for all business routes **only when `coreOperationsAdmission` is explicitly present**, while retaining the old `/auth-check` flow. New HTTP test verifies a service identity can enter without an admin key and the old key alone cannot pass. No production server injects the gate. The precise actor of changes remains an issue: some handlers take `changed_by`, `reviewed_by`, or `created_by` from request data; audit identity must be server-derived before real rollout.

`tests/core-operations-provisional-scopes.test.mjs` verifies all 14 paths exist, no provisional entry automatically becomes an approval, normal vs protected proof, and exact-grant isolation. `tests/core-operations-route-seam.test.mjs` adds the service without legacy credential compatibility check. **Latest CI result must be checked separately.**

## Verified audit attribution guard — 2026-11-11

The source audit found that existing Special Orders handlers sometimes take `changed_by`, `created_by`, `received_by`, `reviewed_by` and `gw_reviewed_by` directly from client requests. These strings are **not a verified identity**, even if a browser presents a signed employee session.

**New default-off development hardening:** `services/security/coreOperationsAuditActor.js` resolves the trusted principal from `req.hcCoreOperationsAdmission`, a property set only by the explicitly mounted trusted backend route admission middleware. In guarded mode it emits a stable `employee:<canonical id>` or `service:<verified id>` actor label and denies missing/malformed admissions. In legacy mode (new guard omitted in `server.js`) it returns the same legacy caller value unchanged.

The current `special-orders.js` handlers now use this actor resolver for user-provided audit fields in Special Orders creation and additions, notes, status, routing, supplier draft and receiving records, preseason pickup events, GW review, Lightspeed PO receiving and notification review. The change **does not modify production until the trusted backend guard is injected**. Existing hardcoded system annotations (e.g. older `ordering-web`/Discord events) are not yet replaced; review every remaining internal audit origin before calling the full audit chain complete.

`tests/core-operations-audit-actor.test.mjs` checks legacy compatibility, verified employee and scoped machine identity attribution, denial of malformed/missing admissions, a real Express HTTP guard-vs-forged-body request, and presence of guarded actor handling at known audit fields. These are isolated fixture tests: **no database audit rows were created or tested**. The latest CI outcome must be confirmed separately.

## Source-and-target-aware Special Order status transitions — 2026-11-12

**Status: In Development / Testing, not deployed or enabled.** The existing `PATCH /items/:id/status` handler accepts ten status values, some of which perform extra effects. In particular, `COMPLETED` and `CANCELLED` suppress pending customer notifications, and `ORDERED`, `RECEIVED` and `HELD` create operational timestamps. Simply allowing a workstation-authenticated employee to choose a routine-looking *destination* would also allow an item to be reopened from `COMPLETED` or `RECEIVED` without strong authorization.

The new `services/security/coreOperationsStatusTransitions.js` defines the **review-pending** split:

| Provisional action | Destination status | Assurance if separately granted |
| --- | --- | --- |
| `special-orders.status.progress` | `OOS`, `READY_TO_ORDER`, `BACKORDERED` | Validated active employee + registered workstation / routine employee-bound MFA **and exact progress grant**, only if the **database-locked existing status is also one of these three** |
| `special-orders.status.write` | `PREORDER`, `ORDERED`, `RECEIVED`, `HELD`, `CUSTOMER_NOTIFIED`, `COMPLETED`, `CANCELLED` | Active employee + fresh independently verified passkey/security key/approved strong IdP MFA **and separate exact protected-status grant** |

This classification is *conservative* and has **not** been accepted as the store's operational policy. `PREORDER` is treated as protected because it may carry campaign/fulfillment implications. A trusted server may opt into the split **only** through an exact `special-orders.js`, `PATCH /items/:id/status`, employee route declaration carrying `operation:'special-orders.status.write'` and `statusPolicy:'locked-transition-v1'`. The application currently supplies **no** such approval. Without explicit opt-in, `status.write` retains its prior step-up classification; no routine progress is granted. An exact `status.progress` approval **cannot** be installed as a static operation or applied to another route.

When this guarded split is *explicitly enabled*, the middleware validates a string body status against all ten known values and selects the **server-defined operation**, which still independently checks the verified employee, factor, and exact backend grant. A granted `status.progress` result records the authorized target. Then, inside the existing `SELECT ... FOR UPDATE` transaction, the business handler checks the **current row status and unchanged authorized target before any UPDATE**. A transition from `COMPLETED`/ `RECEIVED`/ `HELD` to `OOS`, `READY_TO_ORDER` or `BACKORDERED` is rejected even if the target looks routine. This closes the time-of-check/time-of-use downgrade path in the new mode.

**Operational policy still needed:** Which transitions should a cashier be allowed to perform without extra prompts? Whether normal `ORDERED`/receipt updates should have different roles or workstation rules? Do cancellations/completions require two-person review, manager-only grant, or notification confirmation? How should an authorized manager reopen a previously completed/cancelled order? Those are explicit owner decisions; do not assume that `status.progress` should be granted broadly.

`tests/core-operations-status-transitions.test.mjs` exercises ten statuses, invalid/malformed payloads, denial of static routine grants, workstation vs TOTP vs passkey proof, exact grants, locked previous-status checks and actual optional-router HTTP behavior without a database. The handler-source ordering check ensures the locked-state check precedes `UPDATE special_order_items`. **No Postgres row-transition integration, physical employee MFA or real Lightspeed/Discord effects have been tested.** The existing legacy/default path remains unchanged, including its current status handling.

## Manual isolated PostgreSQL status acceptance — 2026-11-12

**In Development / awaiting Codespaces run.** To test the real SQL transaction rather than just mock HTTP/source ordering, added:

- `scripts/run-isolated-security-status-postgres.sh` — a manually executed bash wrapper that **creates a brand-new Docker `postgres:18` container**, dynamically maps its port to **`127.0.0.1` only**, confirms readiness, passes a dedicated test-only DB URL, and **always attempts to remove its own container** on exit. It never reads or reuses `DATABASE_URL` or a Railway database URL. It unsets inherited Lightspeed, Discord and Timeclock service secrets for the subprocess.
- `tests/core-operations-status-postgres-isolated.test.mjs` — only accepts the hard-coded disposable test user/db/password on loopback and refuses any other database URL. Applies the application's real Special Orders SQL schema to the disposable database, then uses the real Express router and independently verified **fixture** staff/factor/grant callbacks. The test checks routine progress, an attempted downgrade from RECEIVED, strong-only CANCELLED suppression of pending notifications, server-derived `employee:42` status history, concurrent SELECT ... FOR UPDATE protection against a stale routine authorization, and forged/unrecognized requests. No actual store customer, vendor, worker, Google, Railway or Lightspeed data is read or changed.

**Codespaces operator command (not production):**

```bash
cd /workspaces/Lightspeed-security && git pull --ff-only && bash scripts/run-isolated-security-status-postgres.sh
```

The wrapper requires a working Docker daemon inside the remote Codespace and may pull the PostgreSQL 18 image. If Docker is unavailable or the loopback binding cannot be verified, it **fails without connecting to any database**. Existing project npm dependencies (including `express` and `pg`) must already be installed in Codespaces. This integration test deliberately does not run on GitHub Actions so routine code-only updates do not launch unnecessary database services.

**Observed Codespaces acceptance — 2026-11-12:** Operator ran this script at `f1c8fbb`. Console showed `database schema ready` and **five passing nested tests plus the parent test** against disposable PostgreSQL 18: routine progress/history, blocked downgrade from RECEIVED, authenticated cancellation with notification suppression, concurrent locked-state protection and rejection of malformed/legacy-key writes. The supplied terminal capture **did not include the final Node test summary or container removal line**, so the process exit and cleanup are not independently established from that capture. No production database was used.

**Additional test-hardening revision (awaiting operator run):** Added two new disposable database cases: `COMPLETED` must suppress both PENDING and QUEUED notification rows without modifying SENT rows; a deliberately injected notification-update failure must roll back the status, timestamp and audit history atomically, then allow a clean retry. The launcher now verifies and prints successful removal of its exact temporary Docker container, and explicitly reports cleanup failure. Seven nested DB tests are now defined; **the two new ones have not yet been run**. They remain manual-only, not a recurring GitHub Action.

**Test boundaries:** This is a disposable local database and simulated staff verifier, not production integration, a device enrollment test, live Lightspeed operation, or staff UX acceptance. Do not activate security route grants on production until this enhanced DB test is confirmed and the physical employee/Owner authorization and operational role policies are approved.

## PostgreSQL rollback fixture correction — 2026-11-12

**Testing blocker identified and corrected in development source; rerun pending.** The owner synced the manual Postgres harness at `e704b58` and reported that **six of seven** nested SQL tests passed. The new `forced notification failure rolls back status, history and timestamps atomically` subtest failed, and the parent suite correctly reported a failure. The terminal excerpt did not include the individual assertion stack or the cleanup confirmation.

Source inspection revealed a concrete **malformed SQL test fixture**: the function body sent to PostgreSQL was `AS $ BEGIN ... END; # Core Operations employee + service admission — development checkpoint (2026-11-11)

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

The status route handles both everyday progression and consequential cancellation. A proposed `locked-transition-v1` request-target classification plus database-locked prior-state check is now implemented but **unapproved and unmounted**; see the dedicated status-transition section below. All 73 other endpoints remain under pending classification (some overlap with these 14 for other methods). The 14 entries are a limited first sample, not a reviewed complete policy.

**Staging service fix:** existing router's old session gate would previously reject a valid machine credential before the new gate could run; the opt-in-only composition now skips legacy auth for all business routes **only when `coreOperationsAdmission` is explicitly present**, while retaining the old `/auth-check` flow. New HTTP test verifies a service identity can enter without an admin key and the old key alone cannot pass. No production server injects the gate. The precise actor of changes remains an issue: some handlers take `changed_by`, `reviewed_by`, or `created_by` from request data; audit identity must be server-derived before real rollout.

`tests/core-operations-provisional-scopes.test.mjs` verifies all 14 paths exist, no provisional entry automatically becomes an approval, normal vs protected proof, and exact-grant isolation. `tests/core-operations-route-seam.test.mjs` adds the service without legacy credential compatibility check. **Latest CI result must be checked separately.**

## Verified audit attribution guard — 2026-11-11

The source audit found that existing Special Orders handlers sometimes take `changed_by`, `created_by`, `received_by`, `reviewed_by` and `gw_reviewed_by` directly from client requests. These strings are **not a verified identity**, even if a browser presents a signed employee session.

**New default-off development hardening:** `services/security/coreOperationsAuditActor.js` resolves the trusted principal from `req.hcCoreOperationsAdmission`, a property set only by the explicitly mounted trusted backend route admission middleware. In guarded mode it emits a stable `employee:<canonical id>` or `service:<verified id>` actor label and denies missing/malformed admissions. In legacy mode (new guard omitted in `server.js`) it returns the same legacy caller value unchanged.

The current `special-orders.js` handlers now use this actor resolver for user-provided audit fields in Special Orders creation and additions, notes, status, routing, supplier draft and receiving records, preseason pickup events, GW review, Lightspeed PO receiving and notification review. The change **does not modify production until the trusted backend guard is injected**. Existing hardcoded system annotations (e.g. older `ordering-web`/Discord events) are not yet replaced; review every remaining internal audit origin before calling the full audit chain complete.

`tests/core-operations-audit-actor.test.mjs` checks legacy compatibility, verified employee and scoped machine identity attribution, denial of malformed/missing admissions, a real Express HTTP guard-vs-forged-body request, and presence of guarded actor handling at known audit fields. These are isolated fixture tests: **no database audit rows were created or tested**. The latest CI outcome must be confirmed separately.

## Source-and-target-aware Special Order status transitions — 2026-11-12

**Status: In Development / Testing, not deployed or enabled.** The existing `PATCH /items/:id/status` handler accepts ten status values, some of which perform extra effects. In particular, `COMPLETED` and `CANCELLED` suppress pending customer notifications, and `ORDERED`, `RECEIVED` and `HELD` create operational timestamps. Simply allowing a workstation-authenticated employee to choose a routine-looking *destination* would also allow an item to be reopened from `COMPLETED` or `RECEIVED` without strong authorization.

The new `services/security/coreOperationsStatusTransitions.js` defines the **review-pending** split:

| Provisional action | Destination status | Assurance if separately granted |
| --- | --- | --- |
| `special-orders.status.progress` | `OOS`, `READY_TO_ORDER`, `BACKORDERED` | Validated active employee + registered workstation / routine employee-bound MFA **and exact progress grant**, only if the **database-locked existing status is also one of these three** |
| `special-orders.status.write` | `PREORDER`, `ORDERED`, `RECEIVED`, `HELD`, `CUSTOMER_NOTIFIED`, `COMPLETED`, `CANCELLED` | Active employee + fresh independently verified passkey/security key/approved strong IdP MFA **and separate exact protected-status grant** |

This classification is *conservative* and has **not** been accepted as the store's operational policy. `PREORDER` is treated as protected because it may carry campaign/fulfillment implications. A trusted server may opt into the split **only** through an exact `special-orders.js`, `PATCH /items/:id/status`, employee route declaration carrying `operation:'special-orders.status.write'` and `statusPolicy:'locked-transition-v1'`. The application currently supplies **no** such approval. Without explicit opt-in, `status.write` retains its prior step-up classification; no routine progress is granted. An exact `status.progress` approval **cannot** be installed as a static operation or applied to another route.

When this guarded split is *explicitly enabled*, the middleware validates a string body status against all ten known values and selects the **server-defined operation**, which still independently checks the verified employee, factor, and exact backend grant. A granted `status.progress` result records the authorized target. Then, inside the existing `SELECT ... FOR UPDATE` transaction, the business handler checks the **current row status and unchanged authorized target before any UPDATE**. A transition from `COMPLETED`/ `RECEIVED`/ `HELD` to `OOS`, `READY_TO_ORDER` or `BACKORDERED` is rejected even if the target looks routine. This closes the time-of-check/time-of-use downgrade path in the new mode.

**Operational policy still needed:** Which transitions should a cashier be allowed to perform without extra prompts? Whether normal `ORDERED`/receipt updates should have different roles or workstation rules? Do cancellations/completions require two-person review, manager-only grant, or notification confirmation? How should an authorized manager reopen a previously completed/cancelled order? Those are explicit owner decisions; do not assume that `status.progress` should be granted broadly.

`tests/core-operations-status-transitions.test.mjs` exercises ten statuses, invalid/malformed payloads, denial of static routine grants, workstation vs TOTP vs passkey proof, exact grants, locked previous-status checks and actual optional-router HTTP behavior without a database. The handler-source ordering check ensures the locked-state check precedes `UPDATE special_order_items`. **No Postgres row-transition integration, physical employee MFA or real Lightspeed/Discord effects have been tested.** The existing legacy/default path remains unchanged, including its current status handling.

## Manual isolated PostgreSQL status acceptance — 2026-11-12

**In Development / awaiting Codespaces run.** To test the real SQL transaction rather than just mock HTTP/source ordering, added:

- `scripts/run-isolated-security-status-postgres.sh` — a manually executed bash wrapper that **creates a brand-new Docker `postgres:18` container**, dynamically maps its port to **`127.0.0.1` only**, confirms readiness, passes a dedicated test-only DB URL, and **always attempts to remove its own container** on exit. It never reads or reuses `DATABASE_URL` or a Railway database URL. It unsets inherited Lightspeed, Discord and Timeclock service secrets for the subprocess.
- `tests/core-operations-status-postgres-isolated.test.mjs` — only accepts the hard-coded disposable test user/db/password on loopback and refuses any other database URL. Applies the application's real Special Orders SQL schema to the disposable database, then uses the real Express router and independently verified **fixture** staff/factor/grant callbacks. The test checks routine progress, an attempted downgrade from RECEIVED, strong-only CANCELLED suppression of pending notifications, server-derived `employee:42` status history, concurrent SELECT ... FOR UPDATE protection against a stale routine authorization, and forged/unrecognized requests. No actual store customer, vendor, worker, Google, Railway or Lightspeed data is read or changed.

**Codespaces operator command (not production):**

```bash
cd /workspaces/Lightspeed-security && git pull --ff-only && bash scripts/run-isolated-security-status-postgres.sh
```

The wrapper requires a working Docker daemon inside the remote Codespace and may pull the PostgreSQL 18 image. If Docker is unavailable or the loopback binding cannot be verified, it **fails without connecting to any database**. Existing project npm dependencies (including `express` and `pg`) must already be installed in Codespaces. This integration test deliberately does not run on GitHub Actions so routine code-only updates do not launch unnecessary database services.

**Observed Codespaces acceptance — 2026-11-12:** Operator ran this script at `f1c8fbb`. Console showed `database schema ready` and **five passing nested tests plus the parent test** against disposable PostgreSQL 18: routine progress/history, blocked downgrade from RECEIVED, authenticated cancellation with notification suppression, concurrent locked-state protection and rejection of malformed/legacy-key writes. The supplied terminal capture **did not include the final Node test summary or container removal line**, so the process exit and cleanup are not independently established from that capture. No production database was used.

**Additional test-hardening revision (awaiting operator run):** Added two new disposable database cases: `COMPLETED` must suppress both PENDING and QUEUED notification rows without modifying SENT rows; a deliberately injected notification-update failure must roll back the status, timestamp and audit history atomically, then allow a clean retry. The launcher now verifies and prints successful removal of its exact temporary Docker container, and explicitly reports cleanup failure. Seven nested DB tests are now defined; **the two new ones have not yet been run**. They remain manual-only, not a recurring GitHub Action.

**Test boundaries:** This is a disposable local database and simulated staff verifier, not production integration, a device enrollment test, live Lightspeed operation, or staff UX acceptance. Do not activate security route grants on production until this enhanced DB test is confirmed and the physical employee/Owner authorization and operational role policies are approved.

 (only one dollar delimiter) instead of valid dollar-quoting. The trigger that should deliberately raise a controlled database exception could not be created in that form. This is a test fixture defect, **not evidence of a production transaction failure**. Fixed the function to a valid single-quoted PL/pgSQL body with escaped quotes in `tests/core-operations-status-postgres-isolated.test.mjs` and added an assertion that the HTTP error specifically contains `fixture induced notification failure`, proving the rollback test exercises the intended injected error.

**Status:** corrected on draft [PR #61](https://github.com/Tawgod/Lightspeed/pull/61) at `b3c01630bd3b7a8627558f579bd0fd90648a107a`; **new corrected version NOT yet run** in Codespaces. The real database transaction implementation, production middleware configuration, employee grants and schemas were **not changed**. Continue with the same manual local-only command:

```bash
cd /workspaces/Lightspeed-security && git pull --ff-only && bash scripts/run-isolated-security-status-postgres.sh
```

Do not mark the seven-case acceptance complete until all seven nested checks and the parent pass, the Node test summary reports no failures, and the script prints verified Docker container cleanup. The launcher only connects to its disposable 127.0.0.1 PostgreSQL fixture.

## Remaining blockers and next work

1. **Granular permissions:** `special-orders.manage` and `ordering.manage` are provisional, excessively broad write actions. Before enabling, split routine order status/notes/staging from financial adjustments, purchasing, customer-data changes, live Lightspeed writes, payment/credit, external publication, and Owner/admin operations. Do not force a passkey for every routine entry or grant broad writes to any employee by default.
2. **Caller investigation:** verify the actual service owners for 14 service/hybrid Special Orders endpoints and 2 external effects. Discord Bot and Rewards deployed source have distinct Timeclock/customer-sync and Rewards jobs; their exact calls to these specific Special Orders endpoints are not proven. Do not change existing unattended workers before auditing and testing them.
3. **Real verifiers and grants:** wire signed session binding, cryptographic station enrollment, true passkey/Authenticator proof and independently scoped machine identities from server-owned adapters; test with real employee IDs in private staging, revocation, logout, expiry and CORS/CSRF behavior. No caller-provided role may trigger a permission.
4. **Web/extension coordination:** keep the four `HCStaffAuth` web clients and Chrome Scanner Timeclock workflows compatible during staged migration. Preserve their current authenticated paths until the replacement is fully tested; extension packaging remains governed by the shared release queue.
5. **Full source reconciliation:** #33/#34/#35/#38/#51/#59/#60 draft branches, 24 direct `server.js` routes, separated Railway services and all existing functional tests. Production Timeclock-only source patch remains staged but uncommitted.
6. **Deployment:** present a separately reviewed staged service rollout with recovery and operator acceptance; no production DB/security privileges/Owner first activation until explicit approval.

This is a **reusable, default-disabled integration seam**, not a completed security cutover. The old production routing still operates under its prior authentication scheme.


## Hidden-write GET classification — 2026-11-12

Three existing GET routes are not side-effect-free: `GET /suppliers`, `GET /products/:id/recommended-suppliers`, and `GET /ordering/lightspeed-context` all call `syncLightspeedSuppliers()`, which reads Lightspeed suppliers and upserts the local `suppliers` cache. The context route also reads live purchase-order, fulfillment, and sale context.

The candidate policy therefore must not authorize these routes with generic `ordering.read` or `products.read`. They are review-pending exact operations: `ordering.suppliers.sync` for supplier refresh/recommendations and `ordering.context.refresh` for the broader context refresh. Both remain routine verified-station candidates because the vendor calls are reads and the local writes are cache refreshes, but each still requires an independent exact backend grant. No route is approved merely because these operation names exist, and the production server still does not mount this candidate guard.
