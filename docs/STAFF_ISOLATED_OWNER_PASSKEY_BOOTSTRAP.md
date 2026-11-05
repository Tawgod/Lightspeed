# Staging first-Owner passkey bootstrap — development candidate

**Status (2026-11-04):** In Development; **not deployed**, no credential registered, no production changes. The existing synthetic test PIN login is user verified. The original live Hobby Corner Timeclock and Discord systems remain out of scope.

## Security boundary

The **first** Owner passkey cannot be approved by an already-registered Owner passkey. This staging-only bootstrap instead combines independent proof of Railway administration with the existing signed test employee session and the device's actual WebAuthn verification.

1. Complete the existing synthetic employee 901 PIN sign-in. The browser obtains a 15-minute signed session and never stores it outside memory.
2. An administrator with authorized Railway environment access separately provisions a fresh random, 256-bit or stronger `HC_STAGING_OWNER_BOOTSTRAP_KEY` and an unrelated `HC_STAGING_PASSKEY_SIGNING_SECRET`. Never use a real employee PIN, Discord bot token, production API credential, or one-time PIN setup key. Do not copy either secret into GitHub or project conversations.
3. When explicitly enabled with **both** `HC_STAGING_OWNER_PASSKEY_ENABLED=true` and `HC_STAGING_OWNER_BOOTSTRAP_ENABLED=true`, under `NODE_ENV=test`, `HC_SECURITY_ENV=isolated-staging`, owner Discord ID `115626919134887940`, guild `1485804234753573066`, persisted PIN storage, and the exact `https://staff-security-staging-test.up.railway.app` origin, the owner opens `/test-owner-passkey` and supplies the independent key *directly* in the private HTTPS page.
4. Both registration stages require the independent key, signed/active synthetic employee session, trusted origin, unused bootstrap record and no preexisting active passkey. The initial registration-options request starts the four-hour authorization window once, **not when Railway migrates/deploys**. If the window expires, it cannot be reopened by retrying the PIN or reusing the key; an audited, explicitly approved staging maintenance procedure is required.
5. The WebAuthn server library verifies the challenge, RP ID, origin and user verification. Only after successful proof does the passkey service invoke the staging-specific commit hook **inside the same PostgreSQL transaction** as the credential and event inserts. It atomically consumes the one-time bootstrap row and records an append-only audit entry. Any failed or racing registration rolls back.
6. After successful registration, the browser can perform real passkey authentication, obtaining a short-lived signed proof bound to that original staff session. This does **not** automatically grant a manager authorization or enable Authenticator QR/recovery.

## Source

- Existing passkey engine: `services/security/staffPasskeysPostgres.js` (optional atomic `commitRegistrationGrant` hook; default behavior unchanged).
- Staging-only guard: `staging/isolated-owner-passkey-grant.js`, exact owner/guild/environment, private key validation and one-use DB lock.
- Staging-only UI: `staging/test-owner-passkey.html`. Existing WebAuthn client receives an optional bootstrap input only on this page and clears it on success/signout/page exit.
- Database: `db/hc_staff_passkeys.sql`, `db/hc_staging_owner_passkey_bootstrap.sql`. The latter creates one inert, unused row with **no running expiry at deployment**. Only the first successful separately authenticated `registration/options` operation starts its four-hour window and writes a `started` audit event atomically; verified credential commit writes a `completed` event. The row can never be restarted after expiration or consumption. It does not auto-reset grants, and the audit is append-only.
- Staging entrypoint: `staging/isolated-test-login.js`; routes mounted only when `HC_STAGING_OWNER_PASSKEY_ENABLED=true`. Existing invitation/Authenticator/approval/recovery routes remain unavailable.
- Test files: `tests/shared-security-owner-bootstrap.test.mjs`, `tests/shared-security-owner-passkey-routing.test.mjs`, existing real ES256 WebAuthn/passkey tests.

## Exact setup before an authorized test-only rollout

- Verify the retirement patch for PIN setup first: `HC_STAGING_PIN_STORE_MODE=database`, `HC_STAGING_PIN_SETUP_ENABLED=false`, no active one-time PIN setup key. **Re-test the existing PIN after that rollout.**
- Keep **both** `HC_STAGING_OWNER_PASSKEY_ENABLED=false` and `HC_STAGING_OWNER_BOOTSTRAP_ENABLED=false` until the independent key is privately provisioned, the user is ready with a passkey-capable device, and source/CI/security review passes.
- On a separately approved isolated deployment, add distinct 32+ byte `HC_STAGING_PASSKEY_SIGNING_SECRET`, high-entropy `HC_STAGING_OWNER_BOOTSTRAP_KEY`, `HC_STAGING_OWNER_PASSKEY_ENABLED=true` and **`HC_STAGING_OWNER_BOOTSTRAP_ENABLED=true`**. Never copy production Timeclock or Malcor secrets.
- **After successful real WebAuthn registration**, verify authentication first. Then disable `HC_STAGING_OWNER_BOOTSTRAP_ENABLED` and retire `HC_STAGING_OWNER_BOOTSTRAP_KEY` without disabling `HC_STAGING_OWNER_PASSKEY_ENABLED` or changing `HC_STAGING_PASSKEY_SIGNING_SECRET`. The backend must continue to verify registered passkeys while denying any new bootstrap registrations. Separate regression tests assert that this restart configuration works. Do not reset the one-use bootstrap database row to regain registration.
- The first-Owner passkey does **not** automatically authorize factor approval. The independent, **default-off** `HC_STAGING_OWNER_APPROVAL_ENABLED` gate and exact-operation policy must be reviewed separately before the existing enrollment/TOTP subsystem is mounted.
- Apply migrations only through the existing `staging/migrate-isolated-test-login.js` private Railway test database guard; verify schema and one-use state. A new deploy must not reset completed grants.
- Require a second-person source review or explicit owner sign-off on how an independent high-entropy key is issued. Do not equate being logged into Discord or knowing the test PIN with independent strong proof.
- Exercise a real device/browser registration and authentication, wrong-origin failure, missing key, replay, expiry, concurrent registration and disabled factor routes. Confirm that the four-hour window **does not begin until the first approved WebAuthn options request**. Do not pre-open the ceremony until ready to register.
- Independently confirm passkey revocation and recovery design before enabling real employee factors. No unrestricted reset via PIN or Discord owner claims.

**Production and real employee enrollment:** remain blocked. The test key proves administrative access to an isolated staging environment, not a production-grade organizational identity. Deployment and Authenticator enrollment are separate review gates.
