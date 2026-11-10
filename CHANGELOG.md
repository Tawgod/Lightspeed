# Hobby Corner Lightspeed — Development Changelog

## 2026-11-06 — Employee Administration & Security foundation (development, unmounted)

- Created draft PR #34 on `feature/employee-admin-security-foundation-20261106`, stacked on shared services Phase 1 branch.
- Added a server-only administrator authentication gate requiring active employee session + recent passkey or TOTP + exact admin permission; privileged changes retain a separate strong step-up requirement.
- Added an extensible source-owned registry to gather all tool settings under one menu, while marking unconnected/unknown tool settings as planned or requiring audit.
- Added an inert responsive admin page with protected read-only discovery routes; no production auth bypass or write APIs.
- Added local/remote idle and absolute timeout validators, and an unapplied PostgreSQL versioned policy store with append-only audit.
- Added automated admission, HTTP/UX, registry and session-policy tests including disposable PostgreSQL.
- No production deployment, Timeclock/Lightspeed writes, extension package or active session policy changes.

## 2026-11-06 — Owner / delegated manager authorization

- Added Owner/delegated-admin permission catalog and durable PostgreSQL principals, explicit admin grants, per-tool operation scopes, per-tool settings scopes, employee tool grants and append-only authorization audit. No automatically granted Owner exists in production.
- Added administrator delegation store with strong-gated Owner-only admin grants; specific delegated manager onboarding, setting, and tool grant capabilities; active Timeclock target checks; prohibited self/Owner privilege mutations; and revocation of manager capabilities.
- Added read-only effective capabilities for server-filtered admin sections, Owner-visible role label, explicit owner permission-management forms and scoped manager tool grants.
- Added integration tests using disposable PostgreSQL and HTTP route checks for no admin access without grant, manager private-record restrictions, out-of-scope grants, unknown employee targets, and revocation.
- Changes remain on draft PR #34 only and are not mounted, deployed or authorized for live employee writes.

## 2026-11-06 — Isolated read-only administrator authentication integration

- Added synthetic isolated-staging admin browser entry using the existing signed staff PIN session followed by independently verified Google Authenticator or WebAuthn passkey. The browser holds proof in memory and discards it on page hide/sign-out.
- Added isolated test-only server-side composition with exact read-only `admin.read` / `tools.settings.read` grants for synthetic employee 901 and strong passkey/TOTP verification against the same bound session. New `HC_STAGING_ADMIN_READONLY_ENABLED` flag defaults off.
- Added read-only capability resolution to the admin metadata API, separating synthetic Owner preview from all real delegation mutation routes. No admin grant store, Timeclock employee writes or tool-setting writers are mounted in the preview.
- Added denial messages, login and factor controls, URL/Origin and forged-role rejection tests, no-write HTTP tests, and browser volatile proof tests.
- Security workflow [42293979612](https://github.com/Tawgod/Lightspeed/actions/runs/42293979612) **SUCCESS** after test-harness correction; no Railway deployment or feature flag activation.

## 2026-11-09 — Minimum employee directory with Timeclock-backed privacy

- Added optional employee directory API guarded by the independent `employees.directory.read` operation; `employees.private.read` controls separate private status fields. An employee with `employees.onboard` alone cannot enumerate existing employees.
- Added a non-mutating Timeclock employee-list endpoint with backend-only admin-secret check to avoid legacy roster GET's implicit Lightspeed sync.
- Added server-only validated Timeclock transport and minimal field projection; no raw PIN hash, Discord IDs, Lightspeed IDs or personal contact data is sent to basic directory consumers.
- Added a hidden, capability-filtered browser employee directory listing that requests records only when the verified server grants independent directory-read access. Current synthetic staging preview does not have that grant or the adapter.
- GitHub Actions Shared Lightspeed foundation `42665224213` and Scanner integration `42665224227` **SUCCESS** at functional/test commit `5fb9606b80cea8a63def3245c1b836cf8ae19317`.
- No admin/Timeclock production deployment, directory data access, employee edit, permission grant, PIN reset or extension release occurred.

## 2026-11-09 — Restricted onboarding, manager scopes, Owner review, policy previews

- Added a minimal, permission-gated and strong-factor-required new-hire request workflow. Manager access is limited to creating/viewing the manager's own requests, without private employee roster access. Request idempotency avoids duplicate creation on retries.
- Added a separately verified Owner-only new-hire review/decision flow; review approval does **not** provision a Timeclock/Lightspeed employee account. All requests and decisions have durable immutable audit events.
- Added server-side exact operation checks and a scoped employee-tool permission read interface for future integration. Production tool authorizers remain untouched.
- Added read-only local vs remote session policy preview against server-bounded rules. No settings-update endpoint is mounted, no Timeclock session TTL is changed, and no policy is deployed.
- Added opt-in/capability-gated admin UI panels and disposable PostgreSQL/HTTP tests to the Shared Lightspeed foundation workflow.
- Automated Shared Lightspeed foundation `42668508441` and Scanner regression `42668509091` **SUCCESS** at final functional/test commit `ef2776400451ce219b8d93d856ced302bde77436`. Later commits are documentation-only.
- No production or staging deployment, real Owner commissioning, live PIN/employee/permissions change, Timeclock API rollout or Chrome extension release.

## 2026-11-09 — Signed-session binding for operation authorization

- Removed any dependency on request-supplied employee ID for prospective exact tool-grant enforcement.
- Require a trusted signed-session verifier callback to resolve employee identity before evaluating the Timeclock active state and exact tool permission. Deny if unavailable.
- Expanded disposable PostgreSQL security test for signed-session binding and spoofed employee-ID denial.
- Shared foundation CI `42669190828` and Scanner regression `42669190918` both SUCCESS at functional commit `81a78d933711836b395c0d50e2dabcb118165ee0`.
- No deployment or production permission change.

## 2026-11-09 — Actual isolated Admin schema and restricted reader provisioning

- Added target-verified one-time schema migrator `scripts/admin-schema-isolated-once.mjs` with transaction, advisory lock, canonical Admin tables and empty principal/grant safeguards; isolated Railway deployment `d39bee4b-14cf-4c8a-ad8b-889c4301362b` **SUCCESS**.
- Added one-time `scripts/admin-nav-reader-isolated-once.mjs` provisioning an independently credentialed `hc_admin_nav_reader` LOGIN with SELECT-only table privileges; isolated deployment `b62b8f3b-6c5c-437c-989e-cd09a02cfd40` **SUCCESS**. Credential in Railway variables, not repository.
- Added unit/rollback tests; Shared foundation Actions `42681876995` and `42682795631`, Scanner `42681877056` and `42682795628`, Admin integration `42681876845` and `42682795964` SUCCESS.
- Separate read-only Railway smoke `2c1384c3-7080-4921-bad7-674572ed17d0` SUCCESS after elevated migration URL disabled. No Owner, manager, employee record or production grant was created; browser Admin navigation not deployed.


## 2026-11-10 — Simplified Timeclock Owner permissions (draft)

- User clarified the first Owner is their **existing active Timeclock employee account**. Preserve the PIN; allow passkey plus Google Authenticator on the same staff identity. External business ownership verification is not required by the requested workflow. The first Owner must still be provisioned through a one-time trusted system operator mapping and a secure activation flow, not auto-promoted by PIN/Discord/UI role.
- `db/hc_admin_delegations.sql` removes the old single-active-Owner draft index and supports auditable multiple Owners. `adminDelegationsPostgres.js` adds strong-factor Owner appointment/revocation with canonical active employee targeting, transaction lock, no self-appointment, no automatic recovery of inactive principals, append-only audit, and final-Owner protection.
- An active, trusted-session Owner inherits all **recognized tool permission grants**. This is only a grant-layer permission and does NOT remove strong login, tool-level write checks, audit requirements or mutation safety.
- `routes/employeeAdmin.js` adds an optional unmounted Owner management POST API requiring the backend delegate; it does not use browser-selected roles to authorize itself. New disposable PostgreSQL and HTTP route regression tests are in `tests/employee-admin-multiple-owners-*.test.mjs`. See `docs/SIMPLIFIED_OWNER_SETUP.md` for planned initial activation and factor setup.
- Branch: `feature/admin-multiple-owners-20261110`; draft PR #52. No live account, PIN, passkey/TOTP seed, migration, Railway or production changes. Reconcile with existing Owner passkey PR #50 before any deployment.
