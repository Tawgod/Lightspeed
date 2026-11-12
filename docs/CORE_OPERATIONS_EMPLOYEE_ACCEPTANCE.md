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

## Source-verified adapter readiness (2026-11-12)

| Boundary | Existing candidate code | Isolated PR #63 deployment / commissioning gap |
| --- | --- | --- |
| Signed active Timeclock employee | `services/staffAuthGateway.js` exposes `verifyBoundEmployee` (HMAC session binding plus fresh `identity.authorize`); `services/scannerSessions.js` validates signature/expiry/JTI | Current isolated foundation app has no real Timeclock identity adapter/session secrets and intentionally does not mount `/api/staff-auth/session` |
| Independently registered store workstation | `services/security/staffWorkstationsPostgres.js` implements Ed25519, durable single-use challenge, 5-minute signed station ticket, session binding and revocation; `routes/staffStationProof.js` is unmounted | No approved device key, independent manager registration, exact staging PostgreSQL schema, test-only secrets or Chrome challenge-response integration attached to PR #63 |
| Routine employee TOTP | `services/security/staffMfaSessions.js` binds an HMAC ticket to signed base session, current factor generation and employee; `services/security/staffSecuritySubsystem.js` can compose PostgreSQL TOTP and durable throttles | Real enrollment/manager approval not commissioned in PR #63; test suite uses code-level TOTP session verification with a simulated code verifier |
| Strong protected-write proof | `services/security/staffSecurityBridge.js` accepts `verifyStrongStepUp` only as an independently trusted backend callback, validates employee/method/freshness | No production-grade RP/origin-bound WebAuthn assertion verifier is wired into this combined service. The new test's signed simulated strong proof is **not** equivalent |
| Persistent exact tool grant | `services/security/coreOperationsRouteAdmission.js` demands an exact `checkPermission` result through the staff gate | No owner-accepted 38-route permission matrix or live durable `TOOL_OPERATIONS` grant adapter is commissioned; all proposal rows remain `review:'pending'` |
| Employee browser, logout and proxy | Existing `shared-ui/staff-auth.js` and prefixed app shell use a common client-side session convention | Isolated PR #63 signed-out/403 tests pass; real authenticated browser with gateway cookie/session origin and revocation not yet tested |

**Pre-enforcement mapping caution:** The route admission factory accepts a *trusted backend-supplied* route/operation tuple; it does **not** independently compare every supplied operation to the still-pending per-route proposal. A commissioning manifest therefore must undergo exact method/path/operation/security-policy review and must never be inferred from generic HTTP methods or browser calls. In particular, an accidentally labeled read operation on a write endpoint would be unsafe; add fail-closed reviewed-manifest validation before any nonzero production or staging grant activation.

**Staging architecture boundary:** `services/security/coreOperationsStagingActivation.js` intentionally demands `approvedRoutes:[]`, explicit live/vendor kill switches and absence of real Owner/Lightspeed/Discord credentials. Do not weaken this protection just to run positive tests. Use a separately reviewed test-only identity composition and distinct authorized deployment when commissioning begins.

## Recommended next step after CI

1. Review employee job-role grant matrix (routine notes/drafts vs protected vendor operations/status changes) and authenticate the owner decision; do not infer grants from the 38 pending proposal entries.
2. Review and implement production-grade server-owned Timeclock employee session, independently registered station attestation, passkey verification and persistent grant adapters on a **separate** isolated test service. No browser/fixture headers.
3. Independently authorize staging identity commissioning and any nonzero route approvals, then test read-only login/logout and revocation before allowing side-effecting handlers. Real vendor calls remain disabled.
4. Confirm Timcorp gateway origin/proxy/cookie behavior with a nonproduction route. Only then consider a production cutover under an explicit rollback plan.
