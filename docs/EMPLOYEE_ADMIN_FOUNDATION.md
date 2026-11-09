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

## Owner and restricted manager delegation — 2026-11-06

**Status: In Development, unmounted.** New per-employee admin role and scoped operation model following owner requirements. The requesting owner will display as **Owner** once the real Timeclock employee ID has been independently linked to a strongly verified owner principal; no live Owner record was assumed or provisioned, and synthetic employee 901 is used **only in disposable tests**.

- `services/security/adminPermissionCatalog.js`: exact permission dictionary for admin entry, employee onboarding, private staff data, Timeclock, tool settings, employee tool grants, devices and audits; client role/extension proof does not confer permissions.
- `db/hc_admin_delegations.sql`: unapplied Timeclock-ID-linked `hc_admin_principals` with one active Owner constraint, admin-grants, tool-grant scopes, setting-specific scopes, per-employee tool grants and append-only authorization events. **No automated owner bootstrap or role inference**.
- `services/security/adminDelegationsPostgres.js`: backend `canAdmin` policy used by `employeeAdminAccess`; denies unappointed employees, requires an explicit `admin.read` grant for delegated managers; owner-only strong verified delegation changes and per-tool/per-setting scope assignment; manager may grant/revoke only the exact tool operations Owner approved, and not to themselves or the Owner. All mutation targets must be independently validated as current active Timeclock employees. Changes require reason and durable audit.
- `routes/employeeAdmin.js`: unmounted, protected admin grant/scope/tool-grant API handlers only when trusted admin delegation adapter injected; response filters sensitive settings metadata for non-Owner tool managers.
- `admin/employee-admin.html`, `admin/employee-admin-client.js`: Owner-labelled verified panel, Owner-only explicit admin grant and tool setting scope forms and separate scoped employee tool-permissions editor for authorized users. No current private employee data or PIN fields; panel remains inert without a vetted admin login adaptor. The current employee ID field is a development placeholder until Timeclock roster selection is integrated. UI hiding supplements rather than replaces server permissions.
- `tests/employee-admin-delegations-postgres.test.mjs` and `tests/employee-admin-delegated-router.test.mjs`: real disposable PostgreSQL and HTTP tests for no ungranted admin access, Owner-only admin grants, manager onboarding privilege without private record reads, out-of-scope tool denial, TOTP-only refusal of privilege mutations, attempted Owner changes, scope enforcement, revoked entry and immutable audit. All migrations remain unapplied outside disposable CI.

**Owner-requested example permission profile:** A delegated manager can receive `admin.read`, `employees.onboard`, `tools.settings.read`, `tools.settings.manage`, `permissions.read`, `permissions.manage`, plus *only* approved tool/setting scopes. They do **not** automatically receive `employees.private.read`, `employees.pin.reset`, `timeclock.read`, `timeclock.manage`, `admin.delegation.manage`, `sessions.policy.manage`, `workstations.manage`, or `audit.read`. Employee onboarding is an authorization contract only—Timeclock onboarding flow still needs vetted adapters before it functions.

**Open issues:** independently provision real Owner Timeclock binding through separate passkey-verified commissioning (never guess from Discord identity, PIN or test employee 901); admin browser WebAuthn/TOTP integration; per-tool setting-specific actual change adapters; operational employee roster; approval of exact production defaults and rollout. No live permission update or production deployment was performed.

## Isolated read-only admin authentication integration — 2026-11-06

**Status: In Development / Testing — source wired behind an OFF-by-default isolated staging feature flag, NOT deployed.** This phase integrates the existing synthetic employee 901 signed staff session, enrolled TOTP proof or verified WebAuthn passkey with the server-only admin admission gate. It does **not** provision a production Owner.

- `staging/isolated-admin-readonly.js` composes `createEmployeeAdminAccess` with the existing `staffAuthGateway.verifyBoundEmployee`, `staffPasskeysPostgres.verifyStrongManager` and existing staff subsystem TOTP verification. The only admitted identity is synthetic isolated employee `901`, and the only permitted operations are `admin.read` and `tools.settings.read`. Origin/cross-site checks are additional guardrails, **not** authentication. Synthetic Owner label is only a test fixture; production Owner commissioning is still a separate approval.
- `staging/isolated-admin-auth-client.js` enables isolated PIN sign-in followed by Google Authenticator OR native WebAuthn passkey verification. Browser keeps base and step-up proof only in memory, clears step-up on visibility loss, clears all credentials on page hide/sign-out and never saves them to URL, cookies or storage.
- `staging/isolated-test-login.js` mounts `/employee-admin/` and `/employee-admin/auth.js` only when **`HC_STAGING_ADMIN_READONLY_ENABLED=true`** AND the existing test-only passkey and enrolled TOTP infrastructure are independently enabled. The flag defaults to off; disabling it exposes no admin route. No admin permission database migrations or writes are required for this preview.
- `routes/employeeAdmin.js` gained a read-only capability resolver used instead of the delegation store. Therefore the isolated preview has **no** `/api/admin-grants`, `/api/employee-tool-grants` or tool-settings writer endpoints. Access denied if signed PIN session exists without independent verified proof.
- `admin/employee-admin.html` includes staging-only hidden PIN and factor forms; generic page can display only metadata after trusted server admission. `admin/employee-admin-client.js` accepts either server-verified factor proof type, shows the permitted role/menu, and provides explicit denial feedback.
- Tests: `tests/employee-admin-staging-readonly.test.mjs` covers disabled feature flag, PIN-only and header spoof denial, cross-origin denial, authentic TOTP/passkey metadata reads, no write routes and static shell; `tests/employee-admin-staging-auth-client.test.mjs` covers synthetic sign-in, volatile factor proof and clearing. CI must pass before any test deployment is considered.

**Remaining gate:** inspect all branch CI; independently approve isolated Railway staging service source update and enabling the new feature flag together, verify no unrelated pending staged Railway changes, test real browser passkey and Authenticator access/expiration, then proceed to true Timeclock employee roster and per-user manager grants. Existing real employee records and Timeclock PINs are untouched. Do not claim that the new admin page is live before a verified Railway deployment.

## Non-mutating Timeclock directory integration — 2026-11-09

**Status: In Development — candidate implemented, isolated from live employee data and not deployed.**

- Audited `Tawgod/Lightspeed:integration/hobby-corner-consolidation/timeclock/server.js`: the existing `GET /api/timeclock/admin/employees` also calls `syncLightspeedUsers()` and therefore is NOT safe for a passive admin-directory refresh. It additionally exposes fields not appropriate for low-privilege managers.
- New additive, backend-secret-protected `GET /api/timeclock/admin/employees/readonly` in the Timeclock server source returns existing PostgreSQL roster rows from `listEmployees()` without triggering Lightspeed roster sync. No GET side effects or new employee editing endpoints. It is **not deployed to the production Timeclock service**.
- New server-only `services/security/adminTimeclockDirectoryReader.js` connects to the non-mutating route with a backend-only admin secret, strict origin and HTTP/private transport checks, no redirects and bounded timeout. Never expose its credential to a browser. The read endpoint is not yet available on deployed Timeclock; integration must await a separately approved Timeclock release.
- New `services/security/adminEmployeeDirectory.js` strips every record down to `id`, `name`, `active` for directory access. A separately authorized private scope may provide limited enrollment/scanner/PTO flags as booleans, but never raw PIN hash, phone, email, Discord user ID or Lightspeed identifier.
- `routes/employeeAdmin.js` accepts an optional trusted `employeeDirectory` adapter. Only then does `GET /api/employees` exist; it requires independent admin authentication **and** exact `employees.directory.read` grant. `?scope=private` requires independent `employees.private.read`. `employees.onboard` alone is insufficient to enumerate records. Neither adapter nor route is mounted in the synthetic staging preview.
- `admin/employee-admin.html` and `admin/employee-admin-client.js` add a hidden, minimal employee directory. The browser requests records only when the verified backend capability list explicitly includes `employees.directory.read`, and renders only name, Timeclock ID and active status. No private flags or raw credential fields are shown. Because synthetic staging Owner only has `admin.read` and `tools.settings.read`, the live preview will not access an employee roster even after a later approved source deploy.
- Automated HTTP, mapping, client privacy and backend reader tests: `tests/employee-admin-directory.test.mjs`, `tests/employee-admin-directory-client.test.mjs`, `tests/employee-admin-timeclock-directory-reader.test.mjs`. Covered by Shared Lightspeed foundation workflow (confirm latest commit CI before describing as passed).

**Remaining:** independent Timeclock no-sync endpoint release and security review, backend-only service adapter wiring with verified environment, real Owner commissioning, live permission/roster data acceptance, and delegated manager negative access tests in a representative environment. No staff records, PINs, permissions, Lightspeed product data or production services were changed by this development.
