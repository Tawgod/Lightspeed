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
