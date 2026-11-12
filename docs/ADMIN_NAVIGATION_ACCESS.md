# Same-origin employee administration navigation gate

**Status:** Development candidate, tested on navigation branch; disabled by default. No production or isolated staging deploy of this integration.

## Purpose

The web navigation link for Employee Administration is shown only after the same-origin Special Orders backend has verified **both**:
1. A signed, unexpired staff PIN session through the shared Timeclock staff-auth gateway, which rechecks that the employee is active at the source.
2. The exact `admin.read` entitlement from the existing dedicated PostgreSQL Admin principal/grant schema.

This lookup is **only a link visibility hint**, not an Admin login. Entering the Admin destination still requires the separately verified enrolled passkey or Authenticator factor with freshness/session binding. The synthetic staging Owner 901 must never be provisioned or inferred as the production Owner by this route.

## Source

- `services/security/adminNavigationAccess.js`: read-only `createAdminNavigationAccessRouter`, `createAdminNavigationGrantReader`.
- `server.js`: mounts only under an active existing signed staff gateway and after the following explicit environment configuration:
  - `HC_ADMIN_NAV_ENABLED=true` (default is off).
  - `HC_ADMIN_GRANTS_DATABASE_URL`: separately provisioned Admin permission database URL, **never** a fallback to the existing Special Orders DB.
  - `HC_ADMIN_GRANTS_PGSSL=true` only where encrypted database transport is independently reviewed/configured.
- `shared-ui/operations-nav.mjs`: takes the volatile signed `HCStaffAuth` bearer, sends it via same-origin no-store GET to `/api/admin/navigation-access`, and hides the link unless the response is precisely `{allowed:true,authenticated:true,operation:'admin.read'}`. Refreshes after staff sign-in, sign-out, and visibility resume.
- `tests/admin-navigation-access.test.mjs`, `tests/hierarchical-navigation-admin.test.mjs`.

The grant adapter issues only a SELECT for an active `hc_admin_principals` Owner or an active delegated administrator with explicit `hc_admin_grants.admin.read`. Missing tables, DB outage, inactive/revoked staff, expired session, or unknown operation cause default denial. No DDL, migrations, permission grants, PIN changes or Owner commissioning are part of this feature.

## Release prerequisites

1. Safely commission the **real** Owner by current Timeclock employee ID and a separate bound passkey ceremony in an isolated reviewed environment. Do not reuse synthetic employee 901 or create roles automatically on startup.
2. Deploy and independently verify the Admin permission schema and grant lifecycle in its dedicated environment, with access limited to this service for read-only capability checks.
3. Review the trusted Timeclock employee verification contract and negative manager/employee tests. The current Timeclock scanner-authorization route selects employees with `active=TRUE` and returns flags for active employees; it is reused as a *signed-session identity validator*, not as scanner permission authority for Admin.
4. Enable the route in a separate approved isolated staging environment; test authorized, non-admin, revoked, signed-out and expired sessions; ensure the destination Admin independently challenges a fresh enrolled factor.
5. Review branch integration with shared services #32/#33 and Admin draft PR #34; request explicit approval before any production database configuration or deployment.

## Acceptance and limitations

- Only exact server-confirmed `admin.read` displays the link.
- Link disappears on sign-out and when access check returns a non-success response.
- A single successful navigation check is not a login and does not grant access to employee data or settings.
- This new service endpoint does **not** accept an employee ID from the client, even if accompanied by `x-hc-role` headers.
- The route's tests currently exercise mocked Postgres and Timeclock adapters; real dedicated database and browser acceptance are still required before release.

## Disposable database access matrix and least-privilege startup gate — 2026-11-09

**Status: Implemented and CI-tested, not deployed.** Added a PostgreSQL-backed integration regression in `tests/admin-navigation-postgres.test.mjs`, running inside a disposable `hc_test` Postgres 16 container using a single transaction and TEMP tables only. The test rejects any non-local database URL and always rolls back. Its synthetic fixtures verify: no implicit Owner/default grant; independently provisioned synthetic Owner allowed; delegated manager without `admin.read` denied; an unrelated setting grant insufficient; explicit `admin.read` allows only navigation visibility; revoke grant causes immediate denial; inactive principal causes denial; ordinary employee denied; invalid/expired signed staff session denied; and POST to read-only endpoint 404. It never touches Timeclock employee records or actual admin data. The compatibility fixture `tests/fixtures/admin-navigation-grants-ci.sql` is **test-only**, not a deployment migration.

`services/security/adminNavigationAccess.js` now includes `verifyAdminNavigationReadOnlyDatabase`. Before mounting the endpoint, `server.js` checks that the dedicated grant tables exist, the configured DB user can SELECT both, and cannot INSERT/UPDATE/DELETE/TRUNCATE either table or CREATE in the schema. If any check fails, Admin navigation remains disabled and the isolated pool is closed. No privileged fallback database is accepted. This preflight prevents a mistakenly write-capable service credential from being used even though this feature issues only SELECT.

The independently reviewed production/staging permission schema remains `Tawgod/Lightspeed:feature/employee-admin-security-foundation-20261106/db/hc_admin_delegations.sql`. Do not copy/release the test fixture as a migration.

**Before integrated staging rollout:** provision a dedicated Admin grant database/schema with a SELECT-only service login; review database connection encryption and secrets; commission a real Owner Timeclock identity through the separate bound passkey ceremony; test a real Owner, granted manager and ordinary employee with separate signed browser sessions; verify revoke and MFA at the destination. None of these configuration or staff changes were performed during this phase.

## Live isolated SELECT-only Railway test connection — 2026-11-09

The test-only `Postgres-O39p` database now has the canonical Admin authorization tables with no principals/grants and a separately credentialed SELECT-only `hc_admin_nav_reader` PostgreSQL login. The nav branch adds `scripts/admin-nav-db-isolated-smoke.mjs` and `tests/admin-nav-db-isolated-smoke.test.mjs`: one-time private host/database/role preflight, exact table SELECT and no DML/schema CREATE, empty principals/grants, a denied synthetic employee, and **SELECT statements only**. GitHub Actions all five nav workflows **SUCCESS** on commit `b3f52098b2407bcb886ed748bf8ad4b7ea7f89f9`. Railway one-time job `admin-grants-schema-once` was repinned to this source; its previous elevated migration URL was blanked and migration flags disabled. Deployment `2c1384c3-7080-4921-bad7-674572ed17d0` **SUCCESS**, runtime confirmed `Admin navigation isolated read-only connection PASS; zero principals and grants.`

This is not a live web navigation endpoint or an Admin login. `HC_ADMIN_NAV_ENABLED` was not activated on staff or production services. No Timeclock employees/Owner/managers were commissioned or granted access. The actual `/api/admin/navigation-access` deployment still requires bound active employee session, exact grant and real-browser denial/revocation testing before rollout.

## Isolated signed-Timeclock navigation bridge candidate — 2026-11-09

**Status: Source implemented and CI TESTED; test Railway service STAGED but NOT DEPLOYED.** Implemented `scripts/admin-nav-isolated-bridge.mjs` with independently enabled test-only configuration and a new private HTTP service. It obtains the separately provisioned `hc_admin_nav_reader` credential and requires the existing `Postgres-O39p` test DB, read-only database privilege preflight and exact DB-user identity. The `GET /api/admin/navigation-access` endpoint shares the canonical read-only grant reader and no-store route, and has a separate /health diagnostic without employee data or permissions. No Owner/manager or employee grants are created or changed.

The optional employee-verifier contract reuses existing `createScannerSessions` 15-minute signed tokens and `createTimeclockScannerIdentity.authorize` to recheck active Timeclock staff identity on every request before checking `admin.read`. It requires **all three independent server-only values**: Timeclock service origin, Timeclock service secret and signing secret. If any one is partially configured, startup is rejected. If **none** is configured, the service can start for read-only DB checks but every Admin authorization request is denied (the test staging deployment is intentionally in this mode). Neither a synthetic Owner/employee ID nor client-supplied role headers can grant access.

`tests/admin-nav-isolated-bridge.test.mjs` covers wrong-environment/host/partial credentials, live route default-deny with verifier missing, valid signed session with injected Timeclock active verification and exact grant, revocation/inactive staff denial, forged token denial and write-capable DB rejection. All five branch GitHub Actions workflows **SUCCESS** on implementation commit `87a9096990af099e085e390639cb312c250a9c5c`: Navigation Admin permission `42695421597`, unified nav `42695421128`, Scanner `42695421298`, shared UI `42695421080`, Core Operations `42695421695`.

**Railway:** a new service `admin-nav-bridge-test` id `73937ea7-1179-4664-9ec5-324da9352564` was **STAGED ONLY**, patch `27985da3-a390-44bb-ae3f-00d08a2fa408`, in `Hobby Corner Integration Test/test`, using pinned SHA `87a9096990af099e085e390639cb312c250a9c5c`, `node scripts/admin-nav-isolated-bridge.mjs`, healthcheck /health, Railway internal PGHOST/PGDATABASE reference and a secret variable reference to the existing read-only test role. No public domain or actual Timeclock credential was staged. Patch is non-destructive; contains only new service, no changes to staff-security-staging, DB, production or Chrome extension.

**Remaining:** explicit deployment authorization to apply this patch; independently reviewed Timeclock signed-session credential integration under the test-only configuration; read-only DB and HTTP deny smoke after deployment; real employee/Owner commissioning via separate passkey ceremony; real browser permission revocation/MFA acceptance. Do not infer any Owner exists merely because a healthy private test service is running.
