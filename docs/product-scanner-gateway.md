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
