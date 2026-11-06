# Employee Administration foundation — draft PR #34

**Status:** In Development, automated CI verified, NOT mounted, NOT deployed.
**Date:** 2026-11-06
**Source:** `Tawgod/Lightspeed:feature/employee-admin-security-foundation-20261106`
**PR:** https://github.com/Tawgod/Lightspeed/pull/34
**Base:** Phase 1 branch `feature/shared-lightspeed-services-phase1-20261029` (unmerged PR #32).
**Business requirements:** `Tawgod/Hobby-Corner:main/EMPLOYEE_ADMIN_SECURITY_PANEL.md`

## Implemented now
- `services/security/employeeAdminAccess.js`: server-only fail-closed administrator gate. Requires active signed employee session, independent passkey OR enrolled TOTP proof, recent factor and exact backend admin grant. For privileged actions (PIN resets, security policies, device and grant changes) require stronger passkey/security key/approved IdP reauthentication.
- `services/security/adminSettingsRegistry.js`: frozen, validated catalog of configuration sections, source owner, implementation status, read/write operation IDs. Future tools add reviewed descriptors through source/manifest PRs, not arbitrary browser-supplied values. Existing API/status must be audited before actual values are wired.
- `routes/employeeAdmin.js`: **unmounted** no-store, CSP-protected static shell and read-only admin metadata endpoints `/api/overview`, `/api/settings`, `/api/settings/:id`. No employee roster, PIN, permission or settings writer routes.
- `admin/employee-admin.html`, `admin/employee-admin.css`, `admin/employee-admin-client.js`: responsive, read-only menu. Inert without trusted `HCAdminAuth` injector; no PIN/seed or token persistence. The injection contract is a placeholder only; do not mount in real services until vetted authenticated caller and passkey/TOTP proof verification are connected.
- `services/security/adminSessionPolicy.js`: validated local/remote idle and absolute timeout policy, preview and proof-based device-class categorization; default 900 seconds both classes, **not integrated with staffAuthGateway**.
- `db/hc_admin_session_policies.sql` and `services/security/adminSessionPolicyPostgres.js`: unapplied, versioned, audited session-policy candidate. Strong admin reauthentication mandatory on update, stale expected version rejected, audit history append-only. Does not alter current session token issuance.

## Security constraints
- Existing active Timeclock employee and PIN authority remains canonical. No second employee database, insecure administrator bootstrap or client-controlled roles.
- The gate's `verifyEmployeeSession` must be the trusted server-side bound-session verifier, not decoded untrusted claims. `verifyTotp` must validate `x-hc-mfa-session` against the SAME base signed employee session and active factor generation; `verifyPasskey` must validate a fresh cryptographic assertion/challenge bound to this specific request and employee session. Both must return backend-owned actor/time only. Neither function is wired in this draft.
- `canAdmin` must be a server-side independent exact-operation checker. No connection to production permission sources is yet provided. A TOTP-verified administrator may read only permitted metadata; high-impact changes require fresh passkey/security key/approved managed-IdP MFA.
- The demo/browser shell has no direct employee sign-in for precisely this reason. Do NOT add client-side owner IDs, synthetic bypass flags, raw token query args, or global admin role shortcuts.
- A store computer is **approved workstation** only after the backend verifies a valid signed challenge proof from a separately registered and non-revoked key. Never classify via IP, hostname or client checkbox.
- Session policy changes require server enforcement of per-employee inactivity and absolute time boundaries; signed JWT TTL alone cannot express idle duration or immediate revocation. Migration/rollout of Timeclock legacy routes and Chrome extension must occur under separate approval. Pending policy values cannot silently extend active sessions.
- The central Tool Settings menu is a registry only. Actual tool settings need dedicated validated read/write adapters with exact permissions, audit/readback/rollback, and owner approval. Lightspeed-only data stays in Lightspeed.

## Automated checks
- `tests/employee-admin-access.test.mjs`: PIN-only denial, unprivileged employee denial, TOTP/passkey entry, strong step-up, metadata validation.
- `tests/employee-admin-router.test.mjs`: authenticated read-only API and denied write routes.
- `tests/employee-admin-client.test.mjs`: inert non-authenticated UI, no credential collection.
- `tests/employee-admin-session-policy.test.mjs`: timeout range enforcement, immutable defaults, local-vs-remote proof-only classification.
- `tests/employee-admin-session-policy-postgres.test.mjs`: disposable PostgreSQL grant, revision conflict and immutable audit behavior.
- `.github/workflows/shared-lightspeed-foundation.yml` runs these on the draft PR.

## Remaining implementation order
1. Read-only admin shell authenticated against the **actual** signed Timeclock employee and registered passkey/TOTP verification, with explicit owner/manager admin grant, before any public route.
2. Establish usable admin sign-in UX and security-review approval. Do not require sending or pasting credentials into chat or logging them.
3. Implement authorized employee roster and Timeclock read APIs, excluding Lightspeed-owned fields.
4. Complete durable idle/absolute policy enforcement, revocation and migration strategy before exposing the versioned policy store/editor.
5. Add audited PIN reset, manager recovery, secure per-installation workstation registration and **verified canonical extension download link** after Chrome release-queue reconciliation.
6. Register each tool's actual supported settings and exact permissions with owner-specific validators; confirm existing Scanner behavior and legacy Timeclock bypass closure, then stage browser acceptance and production change approval.

## Deployment and release status
No production/staging route, railway service, Timeclock PIN, store employee data, Lightspeed record, Chrome extension package or deployment has been changed. PR #34 remains draft; do not merge before review and coordinated integration.
