# Shared Lightspeed Services — Phase 1 Implementation and Verification

**Code status:** Completed for review — 2026-10-29
**Deployment status:** NOT deployed or merged. No production database migration run.
**Canonical architecture:** `Tawgod/Hobby-Corner:main/LIGHTSPEED_SHARED_SERVICES.md`
**Code branch/PR:** `Tawgod/Lightspeed:feature/shared-lightspeed-services-phase1-20261029`, PR #32
**Recovery reference:** `Tawgod/Hobby-Corner:main/backups/2026-10-29-shared-services-phase1.md`

## Implemented modules

| Module | Implementation |
| --- | --- |
| `services/lightspeed/client.js` | Server-only validated Lightspeed HTTP transport: API path, timeout, response parsing, correlation IDs, GET/HEAD retry only, non-retryable uncertain mutations |
| `services/lightspeed/policy.js` | Timeclock/service identity-agnostic policy with fail-closed permissions and construction-time write gates |
| `services/lightspeed/staffAdapter.js` | Verified existing staff-auth/Timeclock request adapter (not new PIN or employee identity infrastructure) |
| `services/lightspeed/audit.js` | Append-only metadata audit contract; fails closed without durable receipt |
| `services/lightspeed/idempotency.js` | Stable SHA-256 request fingerprint, durable atomic claim/lease, verified replay only, uncertain-write protection |
| `services/lightspeed/postgres.js` | PG Pool-backed durable audit and idempotency adapters; no implicit DB migration |
| `services/lightspeed/mutations.js` | Explicit guarded mutation orchestration, tenant/environment scope fixed at trusted server construction, audit before request, readback verification and safe replay |
| `services/lightspeed/customers.js` | Read-only remote customer get/search, preserving Special Orders search query conventions |
| `services/lightspeed/catalog.js` | Read-only category/supplier/brand/tag contracts and extracted category hierarchy parser |
| `services/lightspeed/productIdentity.js` | Special Orders product matching/scoring helpers extracted verbatim for future migration |
| `services/lightspeed/legacyReadAdapter.js` | Opt-in compatibility layer covering all eight legacy read methods, preserving path and response-envelope shape; no write methods |
| `scripts/audit-lightspeed-consumers.mjs` | Source inventory and PR added-lines guard for direct raw vendor clients |
| `docs/LIGHTSPEED_DIRECT_ACCESS_INVENTORY.md` | Explicit consumer ownership and Phase 2 migration map |
| `db/lightspeed_shared_foundation.sql` | Additive, unapplied persistence schema with an audit UPDATE/DELETE/TRUNCATE trigger and durable mutation-key state |

## Safety decisions

- **No production route changes.** The existing `services/lightspeedApi.js`, `special-orders.js`, Scanner isolated writer, Timeclock routes, and Split/Recall API behavior remain in place. The compatibility adapter is tested, not used by current feature routes.
- **Writes not live.** The mutation orchestrator is a library only. It requires a verified employee or service principal, explicit permission approval, durable audit/idempotency stores, a readback callback, and server-side write gates before any vendor mutation.
- **Never auto retry uncertain writes.** A persistent pending/unknown idempotency key blocks a second operation until a separate authorized reconciliation procedure is approved. Keys never expire automatically.
- **Idempotency scope:** `environment:tenant:operation` bound when the backend constructs the orchestrator. Do not derive the tenant from untrusted request JSON or headers.
- **Minimal stored result:** The durable adapter stores a JSONB verified result for replay. Future consumers must only pass a minimal verified receipt (such as Lightspeed ID and result code), not customer PII or complete sale payloads.
- **Existing staff auth:** `staffAdapter.js` wraps the verified `verifyEmployee(req)` flow from the shared staff gateway; it does not use an employee ID or a PIN from untrusted payload as proof of authentication.
- **Schema migration is source only:** `db/lightspeed_shared_foundation.sql` was applied only in an ephemeral GitHub Actions PostgreSQL instance. Do not apply to Railway without explicit release authorization.
- **Existing exceptions:** Scanner isolated test-tenant writer and RMS bulk migration remain separate. Exception paths in the source audit are not authorization to add unchecked writes.

## Tests and evidence

GitHub Actions `Shared Lightspeed foundation` runs:

1. Node contract tests for transport, policy, audit, idempotency, staff identity adapter, customer/catalog reads, and product matching.
2. Legacy read-API path and response-envelope parity fixtures.
3. **Real PostgreSQL 16 (disposable CI database)** integration test for two concurrent claims, persisted verified replay, conflicting keys, unknown writes, write receipts, append-only audit UPDATE and DELETE denial, and no duplicate execution.
4. Existing `server.js` parse, Scanner integration tests, Core Operations navigation and auth/session tests.
5. Source inventory and new direct-vendor-client guard.

Initial CI on early implementation commits uncovered and corrected a SQL template-literal syntax issue; final successful CI run is linked in the central handoff. No production Lightspeed tenant or Railway API write tests were performed.

## Additional fail-closed hardening — 2026-10-29

The following changes were added **after** the initial Phase 1 CI run and require independent CI verification before the PR is considered ready again:

- **Transport write uncertainty:** A vendor HTTP error, including 4xx/409/429 and 5xx, must be treated as **potentially committed** for POST/PUT/PATCH/DELETE. A remote system might have applied a mutation before issuing an error response; the gateway must never infer write failure solely from the HTTP status. Such writes are never automatically retried.
- **Response safety:** Default 2 MiB response limit (configurable from 1 KiB to 16 MiB), with Content-Length early check and streaming byte limits where available. Success responses must parse as JSON or be empty; HTML/text masquerading as successful API output fails closed without exposing upstream body contents.
- **API target validation:** Reject encoded dot segments, slashes/backslashes, control characters and fragments so URL normalization cannot silently change the intended API endpoint.
- **Deterministic payload fingerprinting:** Only finite JSON primitives, plain objects and dense arrays are permitted. Reject dates/classes, getters/accessors, `toJSON`, undefined/BigInt, cycles, sparse arrays and payloads exceeding the 1 MiB/20,000-node/64-depth guard. Distinct wire-level JSON payloads must not collapse to the same fingerprint.
- **Payload mutation races:** Compute a detached approved JSON snapshot for the vendor execution callback; fail before execution if caller-owned payload changed during atomic claim, and mark the outcome unknown after any attempted external write if it changes while executing. Future writers **must use the provided approved snapshot**, not recapture mutable request state.
- **Operational guard:** A persisted pending/unknown key cannot be automatically retried; it needs authorized manual reconciliation. Even pre-execution payload mutation can leave a reserved key pending, intentionally blocking unsafe reuse.

No production route, migration, vendor credential, database or Chrome integration is changed by these fixes. Feature consumers must use audited mutation entrypoints rather than calling transport writes directly.

### Read-only reconciliation support

The PostgreSQL idempotency adapter now provides a **backend-only** `inspect({scope,key})` method returning only fingerprint, state and creation/update/verification times for an exact operation key. This allows an authorized operator to identify pending, verified or unknown mutations without revealing the lease, stored vendor response or customer data. **It does not reset, retry, delete, release or reconcile any key**; manual vendor-side verification and a separately approved recovery contract remain required. PostgreSQL CI checks state transitions and confirms audit records cannot be updated, deleted or truncated.

The mutation tests also prove that failure to append a terminal audit event **after** a verified vendor write cannot cause the same vendor operation to execute again on an idempotent replay.

## Release gates — still required

- Code review of PR #32, schema design and identity/permission mapping.
- Merge and production Railway deployment require **separate explicit authorization**. Production Railway automatically follows `integration/hobby-corner-consolidation`.
- Apply DB migration only through separately approved release coordination; first verify database continuity/backup decision.
- Validate real Lightspeed API versions, envelope pagination and Timeclock role access on a test tenant during **Phase 2 consumer conversion**. Mocks/fixtures cannot prove upstream APIs are current.
- Refactor one consumer at a time; preserve and test old routes until all consumers use the new canonical services and feature/browser regressions pass.
- Source scan catches common direct access patterns only; manual source review is still required.

## Next development phase

**Phase 2:** Extract/convert shared customer/product/catalog/inventory/PO/sale/fulfillment read contracts and migrate initial read consumers. Start from this branch's verified modules, not a second implementation. Check current integration head and open feature PRs before rebasing.
