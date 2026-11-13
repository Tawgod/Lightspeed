# Isolated Employee Read Pilot — staging readiness boundary

**Status:** Testing PASS; source-only draft PR #71 stacked on draft PR #70. Not mounted, deployed, commissioned, or authorized for real employees. Reviewed 2026-11-12. Test evidence: [GitHub Actions 43345338052](https://github.com/Tawgod/Lightspeed/actions/runs/43345338052), source commit `c642c8b967b8ddca1c48b9e6c2fe8c4cefefa7dc`: existing combined regressions 66/66 PASS plus disposable PostgreSQL pilot 2/2 PASS (68 total), 0 failures.

## What the pilot proves

The pilot intentionally reuses existing Hobby Corner security rather than inventing a second login system:

- `staging/isolated-test-identity.js` supplies the existing **synthetic** employee `901`; it does not query or modify real Timeclock and is explicitly identified as `synthetic_staging_only`.
- `services/staffAuthGateway.js` verifies the synthetic PIN and signs a short-lived employee session. The actual workstation verifier then reads its **server-recovered session binding**, not a claimed browser employee.
- `services/security/staffWorkstationsPostgres.js` uses a registered **Ed25519** public key, one-use 90-second challenge, signed response, PostgreSQL row locking, employee/session binding, device generation and immediate revocation. Only a disposable test key and a simulated manager callback are used during CI; there is no employee self-registration endpoint.
- `services/security/coreEmployeePilotGrantReader.js` checks the grant database login's **SELECT-only** privileges. It rejects credentials that can write the table or create in the public schema, and checks privileges and exact unexpired/unrevoked grant in the **same query** before returning true. It can check only synthetic employee `901` and `special-orders.read`. Any DB failure denies.
- `db/hc_core_employee_pilot_grants.sql` defines a separate pilot-only operator-owned table with a single read scope, independent approver ID, 24-hour maximum grant window, and explicit revocation. It does **not** create DB users or permission grants; no migration is automatically run in Railway.
- `services/security/coreOperationsIsolatedReadPilot.js` assembles the trusted staff, station, grant and route gates. It is **unmounted** and accepts only `NODE_ENV=test`, `HC_SECURITY_ENV=isolated-staging`, explicit pilot and test login flags, the `/HobbyCorner` base path, disabled live/vendor/Scanner/Admin options, absent real secrets and a SELECT-only grant reader. The public PR #63 Railway service runs `NODE_ENV=staging` and has its **separate default-deny** guard; it cannot enable this pilot by flipping a flag.
- The pilot is hardcoded to GET `/orders` and GET `/stats`. No POST/PATCH/DELETE, Owner/Admin authorization, worker identity, passkey enrollment, or vendor connection is configured.

The positive HTTP response in CI comes from a synthetic Express handler with empty test-only data. **This is not evidence that real Special Orders records are readable, that staff can log into the existing Railway page, or that the real Timeclock supports this pilot.**

## Disposable PostgreSQL acceptance

The existing `.github/workflows/shared-foundation-security-web.yml` workflow now runs a temporary PostgreSQL 16 `hc_test` container and `tests/core-operations-isolated-read-pilot-postgres.test.mjs` alongside the current combined regressions. This reuses the existing workflow; it does not create a new pipeline or change Railway.

The test refuses non-loopback or non-`hc_test` PostgreSQL. It provisions a temporary, randomly credentialed **SELECT-only** login role distinct from the operator/test database principal and verifies that the runtime cannot UPDATE grant rows or create schema objects. It tests denied/valid synthetic PIN login, one-use Ed25519 challenge, no implicit grant, operator-inserted expiring read grant, real HTTP GET success, rejected POST, claimed Owner/staff role denial, session-rotation proof rejection and immediate grant revocation. The test role and credentials are not written to Git.

Run on a trusted local disposable PostgreSQL 16 instance:

```sh
HC_TEST_DATABASE_URL=postgres://hc_test:hc_test@127.0.0.1:5432/hc_test \
  node --test --test-concurrency=1 \
  tests/core-operations-isolated-read-pilot-postgres.test.mjs
```

Never point this test command at a production, live Railway or populated store database. The suite creates test schemas and a temporary role with the disposable database's operator privileges.

## Explicit blockers to a real employee pilot

1. An **independently approved**, separate test-only Railway project/database and isolated URL; do **not** reuse the existing PR #63 zero-grant preview or locked Owner staging database. Security owner must verify source and environment separation first.
2. An actual dedicated runtime **SELECT-only** database role, provisioned by an independently controlled operator process with read-only access only to the pilot-grant table; approval/audit and expiry/revocation need a reviewed operator workflow. The CI manager callback and operator SQL are test doubles, **not** authorization to enroll store devices or grant real staff permission.
3. A test-only identity issued by an approved canonical test Timeclock authority. Existing synthetic `901` identity is enough for the disposable test but not proof of live Timeclock integration. Avoid real employee PINs/customer data.
4. Independently approved real workstation installation registration and owner/manager consent; Chrome extension additions require the shared extension release queue review. Test signed challenge and revocation on actual hardware.
5. Genuine origin-/RP-bound WebAuthn passkey or verified IdP MFA, using the existing `staffPasskeysPostgres.js` candidate only after enrollment approval and origin assurance, before any protected write. This read pilot deliberately does **not** grant or expose strong operations.
6. End-to-end browser cookies/tokens, login/logout, session expiration/revocation, same-origin/CORS, gateway prefix, admin-nav isolation, business-handler data access and denial tests on the separately authorized staging URL. No Timcorp gateway/DNS changes until independently approved.

**Acceptance level:** Source prepared and disposable PostgreSQL CI **PASS** (68 total tests, no failures). **Not staging deployment ready** for real identities, and not production eligible. PR #71 must remain draft until its security owner reviews these boundaries.
