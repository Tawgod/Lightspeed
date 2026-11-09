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
