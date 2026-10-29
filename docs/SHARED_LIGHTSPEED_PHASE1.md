# Shared Lightspeed Services — Phase 1 integration contract

**Status:** In Development (new modules on an isolated feature branch; no production consumer conversion)
**Canonical architecture:** Tawgod/Hobby-Corner:main/LIGHTSPEED_SHARED_SERVICES.md
**Source:** Tawgod/Lightspeed:feature/shared-lightspeed-services-phase1-20261029
**Baseline recovery:** Tawgod/Hobby-Corner:main/backups/2026-10-29-shared-services-phase1.md

## Phase 1 modules
- services/lightspeed/client.js — validated Lightspeed origin and local API paths, JSON parsing, safe read retries, bounded timeout, correlation IDs, conservative mutation failure handling.
- services/lightspeed/policy.js — delegates authentication to existing Timeclock/staff gateway or a separately verified service identity; defaults to deny and blocks all writes without explicit server-side gates.
- services/lightspeed/audit.js — append-only audit event contract requiring a durable persistence adapter, metadata-only records and confirmed append receipts.
- services/lightspeed/idempotency.js — deterministic payload fingerprint, atomic claim/lease contract, verified-only replay, unknown-write isolation; requires persistent store adapter.
- scripts/audit-lightspeed-consumers.mjs — current raw-access inventory; on PRs, rejects new vendor credential/URL access outside canonical transport and explicit isolated exceptions.

## Safety and readiness

**Not wired into production routes.** Existing services/lightspeedApi.js and Special Orders routes retain their existing public request/response behavior during this phase. New transport is not a replacement until an adapter and representative regressions pass.

**No durable audit/idempotency store adapter is provided yet.** New mutation endpoints are prohibited from using these interfaces until an atomic persistent implementation, audit persistence and failure/recovery tests are in place. In-memory stores are unsuitable for multiple Railway instances.

**Policy adapters are mandatory.** Do not treat request body, browser extension claims or a PIN value alone as authenticated employee identity. Verify current session with the existing staff-auth/Timeclock gateway. Service tokens require server-side verification and minimum operation-scoped privileges.

**Retries:** automatic retries are only for GET/HEAD; POST/PUT/PATCH/DELETE network failures are potentially completed writes and must be reconciled by read-back rather than repeated.

**Exceptions:** Scanner test-tenant writer and RMS migration flows are not redirected through production. The audit scanner's path exception is detection-only, not a permission grant. Every exception needs manual review before merge.

## Next gates

1. CI runs contract tests and source-audit checks for this branch/PR.
2. Review current production client and Special Orders callers for exact backwards-compatibility requirements.
3. Build durable audit/idempotency storage and controlled policy adapters before first production-capable mutation conversion.
4. Migrate read paths one route at a time; verify browser, staff session, Scanner regression and external consumers.
5. Obtain separate approval to merge/deploy production-related changes. Do not make production writes in this phase.
