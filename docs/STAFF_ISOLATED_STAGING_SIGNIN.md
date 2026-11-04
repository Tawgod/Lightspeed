# Hobby Corner — isolated test PIN sign-in

**Status (2026-11-03):** Implemented on development branch, **not deployed**. Never point this service at production Timeclock or Lightspeed data.

## Components
- `staging/staff-security-server.js` starts only under `NODE_ENV=test` and `HC_SECURITY_ENV=isolated-staging`; without the opt-in flag all non-health routes respond 503.
- `staging/isolated-test-identity.js` models one synthetic employee, ID `901`, linked to Discord owner `115626919134887940` in guild `1485804234753573066`. Its test PIN is stored **only as a salted scrypt hash**. No Timeclock admin secret or real employee information is read.
- `staging/isolated-test-login.js` mounts only `/api/staff-auth/session` using signed short-lived sessions and PostgreSQL-backed per-account/per-source throttling. Invitations, MFA enrollment, strong manager approval and QR are **not mounted** by this component.
- The matching invitation service separately verifies exact owner, test guild and test channel, active linked employee and operation-level permission. No Discord role check required in the test environment; production role checks unchanged.

## Railway service configuration (test environment only)

The following **non-secret** values are staged on `Hobby Corner Integration Test / test / staff-security-staging`:

```text
NODE_ENV=test
HC_SECURITY_ENV=isolated-staging
HC_STAGING_TEST_OWNER_DISCORD_ID=115626919134887940
HC_STAGING_TEST_GUILD_ID=1485804234753573066
HC_STAGING_TEST_LOGIN_ENABLED=false
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

**Before enabling sign-in:**

1. Provision the isolated PostgreSQL database, apply `db/hc_staff_auth_throttle.sql` only in the **test** database and verify the database connection. The separate invitation, approval and TOTP schemas are **not** needed to test PIN sign-in.
2. Generate a new random 4-digit *test-only* PIN; do not reuse a real Timeclock PIN. Generate a fresh 16-byte random salt, then use `hashIsolatedTestPin(pin,salt)` locally to create the salted scrypt string. Store **only the hash** in `HC_STAGING_TEST_PIN_HASH`; deliver the actual test PIN privately to the tester, outside GitHub/chat. Four-digit PIN entropy is limited; the persistent throttle is mandatory.
3. Generate two independent random 32+ byte secrets in Railway or a secure vault, and set `HC_STAGING_SESSION_SECRET` and `HC_STAGING_THROTTLE_SECRET` on this service only. Never copy production secrets or expose them in GitHub.
4. Confirm `DATABASE_URL` is a private Railway reference to the **test** Postgres and `HC_STAGING_TEST_LOGIN_ENABLED=true`. Review staged changes, then explicitly approve the test environment deployment. Ensure the superseded empty bot placeholders in the Hobby Corner test environment are excluded before committing the entire staged patch.
5. After deployment, check `GET /health` and `POST /api/staff-auth/session` with the test PIN, then `GET /api/staff-auth/session` with the signed Bearer token. Wrong PIN, unknown token, wrong owner/guild settings and all enrollment endpoints must fail.

**Important:** This sign-in path is *not* a second-factor bootstrap. Activating employee Authenticator signup requires independent first Owner passkey verification, database approval/seed migrations, the separate HTTPS security frontend and a securely configured Malcor backend key.

## Verification

Run `node --test tests/shared-security-isolated-identity.test.mjs tests/shared-security-isolated-login.test.mjs tests/shared-security-staging-entry.test.mjs`. Those are integration tests with synthetic accounts and simulated Postgres throttle; confirm end-to-end operation on an actual isolated Railway PostgreSQL instance separately.
