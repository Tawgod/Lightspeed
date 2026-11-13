# First Owner staging enablement — exact operator gates

**2026-11-12 | PREPARATION ONLY — no migration executed or Owner enrolled**

First selected account: canonical Timeclock employee **1**, confirmed by the operator via the existing protected Hobby Bot Timeclock employee directory. Employee **13** is intended to be appointed later through the authenticated Admin workflow; never bootstrap employee 13 with the first-Owner utility.

## Actual environments — do not conflate them

- **Production Timeclock:** Railway `Hobby Corner / production`; service `dd3469bd-5fce-43bc-b9f9-7aa2a7806457`; deployed source `a595fd336c5a38dcc5ab5423a8967698777c0929`. This source includes default-disabled `/api/timeclock/integrations/owner-staging/{verify-pin,authorize}`. Railway service URL `https://timeclock-production-2bfa.up.railway.app`; network exposure, TLS, and authentication must be independently reviewed. The internal hostname `timeclock.railway.internal` belongs to the **other** Railway project and must not be assumed reachable from the Owner staging project.
- **Owner staging:** Railway `HC PR63 Isolated Staging / staging`, project `5b46096d-3178-47ec-ba88-d5037696346a`, environment `46b93c76-3085-4e76-a37d-90dfdd250dd2`. Existing app `hc-owner-staging` is a **locked** preview on `https://hc-owner-staging-staging.up.railway.app/owner-setup/` with source `60cefaf71d7b737753728f95f8474df17e99912c` and `node staging/owner-locked-preview.js`. Separate Owner PG18 `Postgres-x8Ui` already has restricted Owner tables and roles. **Reuse** both services.
- **Obsolete proposal:** Railway `HC Owner Security Staging / test` has 55 staged CREATE entries under patch `45d1db2e-1f10-4b27-94e0-c0970c5d2d28`. **Never accept** this patch as a shortcut: it creates a second Owner app and database.

## Gate 1 — production Timeclock additive rate limiter (separate production SQL approval)

- Inspect and approve a recoverable PostgreSQL backup/snapshot for the **actual Timeclock production database**; record restore owner and test restoration plan. No existing backup has been independently verified in this handoff.
- Review exactly `timeclock/db/hc_owner_stage_login_limits.sql` against deployed Timeclock schema and current login permissions. It creates one additional table `hc_owner_stage_login_limits`, storing only HMAC scope keys, counts and window starts. Verify the app DB role can atomically INSERT/UPDATE/SELECT this table. The Owner verifier must fail closed if unavailable.
- Database owner explicitly approves and applies **only** this SQL through the controlled production migration channel, never at app startup. Confirm `to_regclass('hc_owner_stage_login_limits')`, the table's check constraints and the intended indexes. Verify existing Scanner, PIN and Timeclock routes remain healthy and that no personnel/permissions records changed.
- Establish a safe key-retention and counter-expiry/cleanup policy. Do not truncate other Timeclock tables. If a migration fails, leave the Owner verifier disabled; no forced production rollback for the unrelated working Timeclock.

## Gate 2 — distinct, server-only Owner identity

- Keep `TIMECLOCK_ADMIN_SECRET`, `SCANNER_SERVICE_SECRET`, and employee PIN pepper **unchanged**. Neither the current shared Hobby Bot admin secret nor the Scanner secret can serve as an Owner credential.
- Timeclock protected variables: `OWNER_STAGING_EMPLOYEE_ID=1`, `OWNER_STAGING_SERVICE_SECRET` (separate random >=32 bytes), `OWNER_STAGING_THROTTLE_SECRET` (another distinct random >=32 bytes), then `OWNER_STAGING_IDENTITY_ENABLED=true` **only after Gate 1 and a separate reviewed enable decision**. Values must remain secret and unused by browsers or Discord. Existing endpoint denies requests by default.
- Review cross-project connectivity: use an explicitly approved HTTPS hostname with strict server-to-server secret, TLS and outbound policy, **not an assumed cross-project Railway internal hostname**. Scope application access to exactly employee 1 via canonical active Timeclock authorization. Independent service credential must match `HC_OWNER_TIMECLOCK_SERVICE_SECRET` on Owner staging, using protected variable handling. No raw credential should be copied into a PR, issue, chat, logs or URL.
- Negative verification: a browser request without the internal credential fails, employee 13 fails, synthetic employee 901 fails, wrong/expired PIN fails, revoked employee 1 fails, and repeated attempts throttle. Validate failure behavior with safe synthetic/mocked credentials **before** real PIN use; do not perform live guessing tests.

## Gate 3 — unlock only the already-deployed isolated Owner app

- Retain the existing hostname `hc-owner-staging-staging.up.railway.app` as the exact WebAuthn RP ID and HTTPS origin. Review same-origin `Origin` and `Sec-Fetch-Site` handling with Railway reverse proxy, TLS, CSRF protection, cache controls, rate limits and session/cookie handling.
- The actual enrollment candidate is `staging/owner-security-server.js` with `services/security/ownerTimeclockStagingBundle.js`, **not** the locked `staging/owner-locked-preview.js`. Compare and test its exact source and dependencies against the locked deployment branch; do not change the start command before prerequisites pass.
- Existing Owner DB `hc_owner_stage_test` must be accessed only by restricted runtime login and preflighted by `verifyOwnerStagingDatabasePrivileges`. The operator credential must remain off the public app. Set `HC_OWNER_TIMECLOCK_EMPLOYEE_ID=1`, approved `HC_OWNER_TIMECLOCK_ORIGIN` and `HC_OWNER_STAGING_ENABLED=true` only as part of a reviewed, staged deployment of this real app. Verify its dedicated signing, session, throttle, passkey, MFA and TOTP keys remain independent and protected.
- Run focused HTTP, PostgreSQL privilege, correct-RP-ID, browser mobile WebAuthn, replay and negative auth tests on the **exact** release commit. Do not deploy against a missing table, missing credential, overprivileged DB login or disabled canonical verifier. Maintain rollback to locked preview and no production role grants.

## Gate 4 — physical enrollment and later production commissioning

- A trusted human operator must personally verify the active employee-1 identity and, in a private interactive terminal using **separate operator DB permissions**, issue the ten-minute one-use first-Owner activation via `scripts/issue-owner-stage-activation.mjs --issue-staging-owner`. That tool explicitly refuses CI, remote non-TTY and any existing Owner/activation. Never emit the activation secret in ChatGPT, CI or captured logs.
- Owner uses personal phone on the trusted HTTPS page, authenticates with their existing Timeclock PIN **on that page only**, completes activation and registers a passkey with physical user verification. Then uses the fresh passkey to authorize Google Authenticator QR enrollment and confirms the six-digit code **on that page only**.
- Exercise sign-out, fresh sign-in, lost-device/recovery, revocation, replay, wrong-employee and rate-limit behavior; staging passkeys are tied to staging RP ID and **will not automatically work on the eventual production host**.
- Staging success **does not grant production Owner**. Obtain separately approved production deployment, strong-auth and audit/recovery review before first real Owner appointment. Employee 13 follows the Admin multi-Owner delegation flow later.

## Current readiness check

| Requirement | Verified | Outstanding |
|---|---|---|
| Real employee selection | Operator confirmed Timeclock employee 1 | Server-side active ID must be rechecked privately |
| Timeclock Owner verifier source | Production code deployed, default-disabled | Schema, dedicated secrets, allowlist and enablement |
| Owner PostgreSQL | Separate isolated DB, login-role separation tested in prior milestones | Live integration with enabled app |
| Owner staging HTTPS | Locked preview deployed at chosen RP ID | Reviewed unlocked source, mobile browser test |
| Owner passkey/TOTP | Candidate code and isolated automated tests | Physical device + private activation, no live Owner |

**This document approves no production migration, gateway edit, release, role grant, PIN reset or token issuance.** Stop if any gate is unverifiable; keep the existing locked preview operational.
