# Product Scanner secure matching — development handoff

Status: **In Development**. Backend gateway module exists but is **not mounted** and has **not been deployed or runtime-tested**.

## Current branch / deployed baseline

- Base: `integration/hobby-corner-consolidation`
- Working branch: `feature/scanner-secure-match-gateway`
- Railway services `lightspeed-api`, `timeclock`, and `special-orders-test` were verified sourcing the consolidated branch on 2026-10-12.
- Scanner foundation remains read-only; the extension currently intentionally fails closed when checking live matches.

## Reuse, not duplication

The existing `routes/specialOrderProducts.js` owns:
- `POST /products/match-local`: local exact and fuzzy matching
- `POST /products/match-remote`: Lightspeed product search

`routes/scannerMatchGateway.js` provides an isolated, **not mounted** `POST /matches` handler requiring two explicitly injected dependencies:
- `verifyEmployee(req)`: trusted employee authentication with server-validated identity and access policy.
- `lookup(kind, payload, employee)`: backend-only calls or shared functions accessing the existing Special Orders matching functionality.

It validates and bounds lookup inputs; runs both lookups; rejects partial results; returns a small allowlisted record instead of private supplier prices or inventory; and provides no write route.

## Security prerequisites before connecting Chrome UI

1. Select a verified employee authentication mechanism (existing trusted session or identity provider), not a secret hardcoded in the extension or the broad `SPECIAL_ORDERS_ADMIN_KEY`.
2. Implement the two injected adapters using server-only credentials and the Special Orders matching implementation. Prefer refactoring matching into shared functions rather than HTTP loopback if safely possible.
3. Add authorization, rate limits, audit events, origin/CSRF defenses appropriate to the chosen session model.
4. Wire the scanner review page to the enabled gateway, test local/remote results, failures, incomplete matching, and browser permissions.
5. Verify that UPC searches cover Lightspeed product codes/GTINs, not SKU alone.
6. Review integration in a separate test environment; obtain approval before any production deploy.

## Tests

`node --test tests/scannerMatchGateway.test.js` tests input validation, data minimization, duplicate merging, failure behavior, and gateway construction. Tests are committed but **not yet executed**.

No change to `server.js`, Railway configuration, PostgreSQL schemas, or Lightspeed product records was made in this branch.

## 2026-10-12 follow-up — reuse adapter added

- Added `services/scannerSpecialOrdersLookup.js`, a backend-only, loopback-restricted client for the existing Special Orders local and remote match endpoints.
- Added `tests/scannerSpecialOrdersLookup.test.js` covering routing, secret isolation, malformed replies, and failures.
- This does **not** expose the administrative key to the extension. The gateway still requires an independently verified employee identity; no identity mechanism has yet been selected.
- The new adapter is not mounted or invoked by `server.js`. Production and the downloadable extension remain unchanged by these commits.
- Test cases are committed but not executed. Next: identify an approved staff authorization mechanism, then wire the gateway to `createSpecialOrdersMatchLookup` and run automated/browser tests before deployment.

## Employee Timeclock authentication and individual permissions (2026-10-12)

Implemented **on the feature branch only**:

- Timeclock `employees` gains `scanner_can_lookup` and `scanner_can_approve`, both defaulting to false. Migration runs only when that Timeclock service version is deployed.
- The existing Timeclock 4-digit PIN hash + active employee record is reused by `POST /api/timeclock/integrations/scanner/verify-pin`. Unlike clock-in, a name alone is **never** sufficient for scanner sign-in.
- The server-to-server endpoints `verify-pin` and `authorize` require `SCANNER_SERVICE_SECRET` (a separate server-only secret, at least 32 characters). They return minimal identity and current permissions, never PIN hashes.
- The existing Timeclock admin secret guards `POST /api/timeclock/admin/employees/:employeeId/scanner-permissions`, requiring explicit `canLookup` and `canApprove` booleans. Approval implies lookup. Every permission change is written to `audit_log` without PIN hash disclosure.
- `services/scannerTimeclockIdentity.js` invokes Timeclock using the server-only secret. `services/scannerSessions.js` issues 15-minute HMAC-signed scanner sessions; `services/scannerTimeclockGateway.js` handles PIN sign-in and checks the employee's active status and current lookup permission on every match request.
- Approval remains a **permission only**; scanner product-creation and update endpoints are not implemented or enabled.

**Before deployment:** Configure `SCANNER_SERVICE_SECRET` on both relevant server services and `SCANNER_SESSION_SECRET` on the Lightspeed API backend (never in Chrome); choose a server-side Timeclock origin; connect gateway dependencies and mount it; implement centralized login throttling/lockout appropriate for 4-digit PINs across Railway instances; apply CSRF/origin restrictions where applicable; review and run tests; approve a non-production test rollout before production.

The live Chrome extension still has no credential form or enabled duplicate lookup. No Railway variables, databases, or deployments have been changed.

## Employee lookup default and scanner sign-in — 2026-10-12

Owner decision: all **active** Timeclock employees with an assigned PIN may look up products by default; modifying products remains opt-in per employee.

- New `scanner_can_lookup` columns default to `TRUE`; existing columns receive a default of `TRUE` for newly added employee records. The `scanner_can_approve` default remains `FALSE`.
- Administrators can override either permission using the existing Timeclock admin-only scanner permission endpoint. Previously explicitly revoked lookup permissions are **not** overwritten by this schema change.
- Chrome scanner review includes a Timeclock 4-digit PIN sign-in form, sign-out action, and authenticated read-only matching request handling at `/api/scanner/session` and `/api/scanner/matches`.
- The PIN is sent to the configured API only, cleared after each attempt and never persisted in Chrome storage. The 15-minute scanner bearer token remains **in the review window's memory**.
- Product creation and product update buttons remain disabled.
- Tests in `tests/scannerDefaultPermissions.test.js` were committed. The JS source passed syntax parsing, but integration and browser tests have not been executed.

**Not live:** The scanner authentication gateway is deliberately not mounted in `server.js`; its Timeclock backend services and required server-only secrets have not been deployed. Until that is safely wired and tested, the sign-in option will report the scanner sign-in service as unavailable. An installed extension is not automatically updated by development branch commits.

## Gateway connection assembled — 2026-10-12

The **code path** is now connected, but **not yet deployed**:

1. `special-orders-test` is the intended backend host because its existing Railway configuration contains `SPECIAL_ORDERS_ADMIN_KEY`; `lightspeed-api` does not.
2. `server.js` mounts `/api/scanner` only when `SCANNER_ENABLED=true` and all required server-only environment values are set. The service fails closed on incomplete enabled configuration.
3. PIN sign-in calls Timeclock `/api/timeclock/integrations/scanner/verify-pin` through the server-only `SCANNER_SERVICE_SECRET`; signed 15-minute sessions verify current Timeclock lookup permission on each call.
4. Matching calls existing local and remote Special Orders product endpoints over **loopback** within the same process, using the already configured server-side Special Orders admin key.
5. A PostgreSQL-backed multi-replica PIN attempt limiter is required before the gateway can start; `services/scannerLoginLimiter.js` uses the shared database and creates its own small `scanner_login_limits` table on enabled startup.
6. Scanner extension development version `0.3.19` points to `https://special-orders-test-production.up.railway.app/api/scanner`. No credentials are embedded in extension source. Creating or editing Lightspeed products remains disabled.

**Activation checklist (not done):**

- Review and test the new Timeclock routes and scanner gateway. In particular, test browser CORS and origin headers, successful/failed PINs, revocation, audit log, lockouts, session expiry, and partial Lightspeed outages.
- Set the same distinct generated 32+-character `SCANNER_SERVICE_SECRET` on Timeclock and Special Orders; `SCANNER_SESSION_SECRET` and `SCANNER_LOGIN_LIMIT_SECRET` only on Special Orders. Set `SCANNER_TIMECLOCK_ORIGIN` to the verified Timeclock HTTPS origin, and `SCANNER_ENABLED=true` **only** on `special-orders-test`, not on `lightspeed-api` or `timeclock`.
- Use a controlled non-production rollout before configuring any production service, and never claim that the code commit enabled the Railway connection.
- Evaluate default scanner lookup grants carefully: schema default `TRUE` applies to new/backfilled employee rows when column is first created; administrators retain the ability to revoke individual lookup rights. Approval remains default `FALSE`.

Changed files: `server.js`, `timeclock/server.js`, `services/scannerLoginLimiter.js`, `services/scannerTimeclockIdentity.js`, `services/scannerSessions.js`, `services/scannerTimeclockGateway.js`, `services/scannerSpecialOrdersLookup.js`, `routes/scannerMatchGateway.js`, Chrome extension files, and scanner tests. Production is unchanged.
