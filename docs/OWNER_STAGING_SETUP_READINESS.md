# Hobby Corner Owner Security — Staging Setup Readiness

**2026-11-10 — Draft PR #58. NOT DEPLOYED.**

This is the current handoff for safely connecting the existing Timeclock employee account to its first Owner passkey and Google Authenticator. It deliberately preserves the employee's four-digit PIN, avoids external business identity providers and never uses synthetic employee `901`.

## Prepared in source

- `services/security/ownerTimeclockStagingBundle.js`: refuses invalid startup configuration; uses existing **server-side** Timeclock Scanner identity contract (`verify-pin` and `authorize`) and signed Staff Auth sessions. Login and later authorization are limited to the exact operator-selected employee ID, with canonical active Timeclock provenance.
- `services/security/ownerSecurityStagingMount.js`: shared HTTPS-origin Owner setup, passkey authentication and existing encrypted TOTP/QR employee security settings. Requires approved separate keys, persistent rate limits, and no synthetic stage user.
- `services/security/ownerStagingDatabasePreflight.js`: checks required tables exist and the public runtime DB role cannot INSERT/DELETE/rewrite first Owner activation approval facts; the runtime has only the limited consumption column updates.
- `staging/owner-security-server.js`: standalone, fail-closed staging startup, requiring a dedicated database called `hc_owner_stage_test` through `HC_OWNER_STAGING_DATABASE_URL`. It **never** applies migrations and does not read default `DATABASE_URL`. The existing Railway `staff-security-staging` service is untouched.
- `scripts/issue-owner-stage-activation.mjs`: local **interactive** operator-only issuer, which independently reads Timeclock's canonical employee, asks the operator to confirm the exact ID, creates a 32-byte secret and saves only its SHA-256 digest for ten minutes. It refuses non-TTY/automated execution and does not issue a token if any Owner or prior activation record exists. The private activation token is shown once to the authorized local operator, never in logs, GitHub, or this chat.
- Existing `staff-security.html` includes Owner passkey-backed enrollment approval, Google Authenticator QR and six-digit confirmation; same Timeclock account, no new employee row/PIN change.

## Before first authorized staging launch

1. **Authorized Timeclock access.** Verify the real active employee ID through a trusted back-office lookup. Identify the current approved backend-only Timeclock integration endpoint and arrange a dedicated server-to-server credential. Do not paste either the PIN or the integration secret into chat or GitHub.
2. **Isolated HTTPS hostname.** Choose a new staging host and WebAuthn RP ID (the RP ID must equal the hostname in the current candidate). Do not reuse the old synthetic login hostname. Validate Railway reverse-proxy forwarding rules, secure Origin / Fetch Metadata, TLS and rate limiting with a physical browser.
3. **Dedicated DB and two roles.** Prepare a new PostgreSQL database named `hc_owner_stage_test` with separately reviewed migration/operator and public runtime roles. Apply only the approved required test schemas out of band. The public app role must not be able to insert, delete, or alter the approval target, digest or expiry; permit limited consumption columns. Verify this with the read-only startup privilege check. Back up before any real migration.
4. **Distinct staging secrets.** Supply secrets through protected Railway configuration, never files/PR/chat. Set: `HC_OWNER_TIMECLOCK_SERVICE_SECRET`, `HC_OWNER_SESSION_SECRET`, `HC_OWNER_THROTTLE_SECRET`, `HC_OWNER_PASSKEY_SIGNING_SECRET`, `HC_OWNER_APPROVAL_HMAC_SECRET`, `HC_OWNER_MFA_SESSION_SECRET`, and an independently generated 32-byte Base64 `HC_OWNER_TOTP_ENCRYPTION_KEY`. Never share values or reuse production secrets.
5. **Required non-secret configuration.** `NODE_ENV=test`, `HC_SECURITY_ENV=isolated-staging`, `HC_OWNER_STAGING_ENABLED=true`, `HC_OWNER_TIMECLOCK_EMPLOYEE_ID` (exact confirmed real ID), `HC_OWNER_STAGING_ORIGIN` (exact HTTPS origin), `HC_OWNER_STAGING_RPID` (host), `HC_OWNER_TIMECLOCK_ORIGIN` (approved Timeclock origin), `HC_OWNER_STAGING_DATABASE_URL` (dedicated app-role DB secret) and `PORT`. Ensure `HC_STAGING_TEST_LOGIN_ENABLED` and `HC_STAGING_PIN_SETUP_ENABLED` are not true.
6. **Operator-only first activation.** In a directly controlled private terminal with a separate operator DB credential, set `HC_OWNER_OPERATOR_DATABASE_URL` and `HC_OWNER_OPERATOR_REF`. After personally verifying the real employee mapping, set `HC_OWNER_OPERATOR_ACK=I_VERIFIED_EMPLOYEE_ACCOUNT` and run `node scripts/issue-owner-stage-activation.mjs --issue-staging-owner`. Confirm the exact employee ID when prompted. **Never execute this through AI/CI or remote captured logs.** This action writes one-time staging authorization data; do not run until explicitly authorized.
7. **Acceptance only, before production.** Start the new isolated server only after schema/privilege/origin preflight succeeds. On a trusted private staging link, sign in with the existing Timeclock PIN, register a real phone/security-key passkey, verify fresh passkey authentication, approve Google Authenticator on the same employee identity, scan QR and confirm a six-digit code. Test expiry/replay, revoked employee, lost-device recovery and a second-owner grant in reviewed staging. Do not test with the production Owner role.
8. **Production is separately gated.** Consolidate all draft branches and review security/rollback and disaster recovery, then obtain explicit authorization for *each* production migration, deployment and actual Owner role commissioning. Never deploy a test-only factory to production merely by flipping environment flags.

## Current verification and limitations

- Automated tests execute fake Timeclock HTTP responses and disposable PostgreSQL/WebAuthn fixtures. The staging preflight includes no network call during construction; a real Timeclock request happens only when an authorized operator runs the issuer or an approved staging service authenticates someone.
- There is **no working live Owner setup URL** yet. The existing Railway Integration Test's staff-security-staging is older synthetic-only code and must not be used for a real Owner.
- The GitHub/Railway connection reading the main `Hobby Corner` Railway project currently lacks viewer permission, so the actual authoritative Timeclock endpoint cannot be confirmed through that project. Do not guess it.
- No production employee record, PIN, passkey, TOTP factor, Owner permission, database or Railway deployment has been changed.

## Future end-user sign-in

Everyday: existing Timeclock PIN. Protected Owner actions: registered passkey; Google Authenticator is a second factor in the same account. Additional Owners are appointed from the strongly authenticated Admin menu; the initial activation utility is permanently single-use.
