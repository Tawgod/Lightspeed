# Core Operations — employee admission and factor acceptance candidate

**Status: Testing (in-process only).** This document describes a proposed test of the security boundary, not approved operating policy, employee enrollment, real passkey verification, or a deployed authenticated feature. Last source review: 2026-11-12.

## Scope and source

- Parent: `Tawgod/Lightspeed:feature/shared-foundation-security-web-20261112@50fda74b19a3701d60e992db4850668d6c85b3f1`, the exact commit deployed only to the PR #63 isolated staging app.
- This separate development branch adds `tests/core-operations-employee-acceptance.test.mjs` to the existing bounded **combined shared foundation** CI workflow. No additional GitHub workflow, Railway variable, database migration, API, credential, service or real staff identity.
- Uses actual, existing application **admission** and **staff session/MFA policy** modules: `createStaffBoundSessionAdapter`, `createStaffMfaSessions`, `createStaffSecurityAccessGate`, `createCoreOperationsRouteAdmission`, plus the current zero-grant staging composition.
- Test-only staff IDs `42` and `84`, ephemeral per-test HMAC keys, signed base sessions, separately signed station/strong proof, session-bound routine TOTP tickets and exact in-memory operation grants. **The signed strong factor is only a simulation of a trusted backend result; it is NOT a real WebAuthn passkey.** The test credentials never leave the Node process and are never recognized by Railway.
- Each of the 38 **review-pending** employee route proposals is exercised in an explicit one-route-at-a-time *local* allowlist with an independent exact grant. Assertions check: no grant denies, correct signed session + routine workstation proof or privileged step-up permits only that operation, no proof denies, TOTP fails high-impact writes, exact grant revocation denies. The temporary local allowlist is **not** the live application's allowlist; proposals remain pending.
- Focused checks additionally exercise signed TOTP ticket identity and base-session binding, factor-generation revocation, cross-employee station/strong-factor replay denial, inactive/expired sessions, and query/body/status-based promotion to separate high-assurance operations. Zero-grant public staging composition still denies an otherwise completely signed synthetic fixture.

## Acceptance boundaries

**What passing tests establish:** Code-level compatibility of the security bridge, MFA ticket verification, operation catalog, route classifier and exact-grant admission under fully synthetic identities. These are in-process authorization calls, without business handlers performing changes.

**What remains unverified:** Real Timeclock token issuance/refresh/revocation, registered hardware workstation cryptographic challenge-response, a genuine passkey/security-key or IdP ceremony, persistent backend employee grant storage and owner approval, routine vs privileged job-role usability, authenticated browser session and cookies under the direct Railway origin and future Timcorp gateway, database writes/audit attribution, deployed worker identities, and failure recovery.

**Safety:** The existing isolated Railway service `hc-foundation-pr63` must remain `approvedRoutes:[]`; no test identities/credentials or route approvals may be installed there as part of this code-only test. Do not change Owner locked preview, real employee/Owner enrollment, Timcorp gateway/DNS, production or Lightspeed/Discord credentials.

## Recommended next step after CI

1. Review employee job-role grant matrix (routine notes/drafts vs protected vendor operations/status changes) and authenticate the owner decision; do not infer grants from the 38 pending proposal entries.
2. Review and implement production-grade server-owned Timeclock employee session, independently registered station attestation, passkey verification and persistent grant adapters on a **separate** isolated test service. No browser/fixture headers.
3. Independently authorize staging identity commissioning and any nonzero route approvals, then test read-only login/logout and revocation before allowing side-effecting handlers. Real vendor calls remain disabled.
4. Confirm Timcorp gateway origin/proxy/cookie behavior with a nonproduction route. Only then consider a production cutover under an explicit rollback plan.
