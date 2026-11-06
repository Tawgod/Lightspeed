# Hobby Corner — Isolated Owner Authenticator Enrollment Pilot

**Status:** In Development / Testing. This is a staging-only plan, not a production rollout.
**Source:** `Tawgod/Lightspeed:feature/shared-lightspeed-services-phase1-20261029`.
**Staging:** Railway project `Hobby Corner Integration Test`, environment `test`, service `staff-security-staging`.

## Security boundaries

- The existing synthetic staging employee (`901`) is independent of the real Owner's Timeclock record. Never use a real employee PIN or production Lightspeed credentials.
- First Owner WebAuthn bootstrap was retired after the Owner reported successful five-minute proof verification. Keep `HC_STAGING_OWNER_BOOTSTRAP_ENABLED=false` and `HC_STAGING_OWNER_BOOTSTRAP_KEY` empty.
- Only an **existing, freshly verified device passkey proof**, signed staff session and the exact `staff.authenticator.enroll` operation can approve a pending request. Four-digit PIN or Discord role alone cannot approve.
- Enrollment is separate from timeclock clock-in, staffing hours or shifts. No production write permissions are granted by an Authenticator.
- Enrollment request/approval, TOTP seeds, invitation redemption and one-time token storage are server-enforced; recovery/reset remains disabled.

## Before activation

The following **five missing independent secrets** must be provisioned in the isolated Railway service, never in GitHub, chat, or Discord:

| Variable | Requirement |
| --- | --- |
| `HC_STAGING_APPROVAL_HMAC_SECRET` | Independently generated random string, at least 32 characters |
| `HC_STAGING_MFA_SESSION_SECRET` | Different independently generated random string, at least 32 characters |
| `HC_STAGING_INVITE_BOT_SECRET` | Different independently generated random string, at least 32 characters; eventually configure test Bot to match via secure secrets |
| `HC_STAGING_INVITE_TOKEN_SECRET` | Different independently generated random string, at least 32 characters |
| `HC_STAGING_TOTP_ENCRYPTION_KEY` | **Exactly 32 random bytes, standard Base64-encoded** (44 characters, ends in `=`). Not the same as the other secrets |

Generate values on a trusted device; a secure local Python interpreter can produce the first four with `secrets.token_urlsafe(32)`, called separately for each; use `base64.b64encode(secrets.token_bytes(32)).decode()` for the TOTP key. Enter values in Railway's private test service Variables only. Do not put raw values in logs or setup reports.

Before exposing any route, validate the non-secret prerequisites:
`NODE_ENV=test`, `HC_SECURITY_ENV=isolated-staging`, exact staging HTTPS origin, synthetic identity and private test Postgres, `HC_STAGING_TEST_LOGIN_ENABLED=true`, `HC_STAGING_PIN_STORE_MODE=database`, `HC_STAGING_PIN_SETUP_ENABLED=false`, `HC_STAGING_OWNER_PASSKEY_ENABLED=true`, `HC_STAGING_OWNER_BOOTSTRAP_ENABLED=false`, `HC_STAGING_OWNER_BOOTSTRAP_KEY` empty. The source validates that the registered first Owner passkey's credential matches the consumed one-time bootstrap before additional enrollment schemas are migrated.

## Separate activation gate

After verifying the secrets and test-only database boundary, explicitly stage:
- `HC_STAGING_OWNER_APPROVAL_ENABLED=true`
- `HC_STAGING_OWNER_ENROLLMENT_ENABLED=true`

Review all staged changes for unrelated resources, then commit *only to the test environment*. Verify Railway health and expected guarded routes. Do not activate in production or connect production Discord bot.

## Manual verification flow

1. Sign in as the synthetic staging employee using the isolated test PIN at `/test-login`. For the invitation-only pilot, issue an invitation through an **approved, independently authenticated test Bot**; the production Bot integration is not deployed.
2. Redeem the private one-use invitation at `/staff-security/#invite=<token>`. The browser strips the fragment and requires a matching signed synthetic employee session. The employee sees a pending request ID.
3. In a separate browser view, visit `/test-owner-passkey`. When enrollment is explicitly enabled, this serves the *approval-only* page, keeping new passkey creation unavailable. Sign in, verify the pre-registered Owner passkey, enter the exact pending request ID, and approve within the five-minute proof lifetime.
4. Return to the employee's settings page; confirm approval, start setup, scan the QR with Google Authenticator (or enter the manual key) and confirm a six-digit code. Secrets and QR must remain on the employee's own device and not in screenshots, chat, or bot logs.
5. Test negative cases: missing or stale passkey proof, wrong request/employee, expired or replayed invite, revoked employee, wrong or replayed TOTP, sign-out/session expiry, new passkey registration denial, and all recovery/reset routes denied.

**Important:** This pilot is currently **Blocked** by missing independent staging secrets and an unconfigured test-bot invitation path. Code and automated test coverage are not a substitute for actual device/Discord acceptance. Do not use a production Discord invite to compensate.
