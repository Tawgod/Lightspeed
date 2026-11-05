# Owner-only test Authenticator enrollment — staged development plan

**Status:** In Development / Testing; not deployed; no live factors issued. Scope is only the synthetic test employee `901` in the dedicated Hobby Corner Integration Test Railway project. Production Timeclock, production Hobby Bot and Lightspeed are not involved.

## Existing infrastructure reused
`staging/isolated-owner-enrollment.js` composes the already developed `createStaffSecuritySubsystem` with a real verified Owner passkey, the exact-operation `createIsolatedOwnerApprovalPolicy`, original invitation service, existing durable staff factor approvals, TOTP encryption, browser settings page, and staff MFA sessions. It mounts **only** behind the separate `HC_STAGING_OWNER_ENROLLMENT_ENABLED=true` flag. There is no second Authenticator database or alternate PIN verifier.

The isolated test flow is:
1. Malcor owner sends self-only private invitation after exact owner/guild/channel and bot-key verification. No Discord role IDs needed on this test server.
2. The same synthetic test Owner signs in with the existing four-digit test PIN and redeems the one-use invitation into a pending, session-bound approval request.
3. An independently enrolled WebAuthn Owner passkey verifies the exact `staff.authenticator.enroll` approval operation. This uses a **separate** short-lived signed manager proof; PIN, TOTP, owner Discord mention and browser role claims cannot approve.
4. The original employee session begins TOTP enrollment, receiving a locally generated QR/manual key only **after** approval. A valid six-digit code confirms the encrypted factor; audit records remain durable and immutable.
5. Passkey and factor recovery/reset are never enabled by this test composition.

The synthetic Owner can approve their own synthetic request only in this isolated test environment; production may require an independent real manager and must use real server-side employee permissions.

## Mandatory activation gates

All flags and secrets must be configured in the **isolated staging security API service**, never in GitHub/chat or production.

- `NODE_ENV=test`, `HC_SECURITY_ENV=isolated-staging`, exact test owner `115626919134887940`, test guild `1485804234753573066`, authorized test channel `1566905099429744700`, and `HC_STAGING_PUBLIC_ORIGIN=https://staff-security-staging-test.up.railway.app`.
- Working user-verified database-backed synthetic PIN; `HC_STAGING_PIN_SETUP_ENABLED=false`.
- Working registered Owner passkey: `HC_STAGING_OWNER_PASSKEY_ENABLED=true`, **`HC_STAGING_OWNER_BOOTSTRAP_ENABLED=false`** and retired/empty `HC_STAGING_OWNER_BOOTSTRAP_KEY`. The independent first-Owner WebAuthn grant must be consumed and match exactly one active passkey for employee `901` in PostgreSQL; the startup migration refuses otherwise.
- Explicit extra `HC_STAGING_OWNER_APPROVAL_ENABLED=true` and `HC_STAGING_OWNER_ENROLLMENT_ENABLED=true`. Neither flag may be silently enabled by registering a passkey.
- Generate separate independent 32+ character private secrets for `HC_STAGING_APPROVAL_HMAC_SECRET`, `HC_STAGING_MFA_SESSION_SECRET`, `HC_STAGING_INVITE_BOT_SECRET`, `HC_STAGING_INVITE_TOKEN_SECRET`. Also retain distinct `HC_STAGING_SESSION_SECRET`, `HC_STAGING_THROTTLE_SECRET` and `HC_STAGING_PASSKEY_SIGNING_SECRET`.
- Generate a separate random **32-byte** AES-256-GCM key; store only its Base64 value as `HC_STAGING_TOTP_ENCRYPTION_KEY`. Never reuse a session/bot/approval secret for this encryption key. Back up securely before activating factors; losing the key makes stored test TOTP factors unreadable.
- Share the invitation bot credential between Malcor test staging and this API by **Railway secrets only**, not Discord/chat/GitHub. Confirm Malcor's invitation code and backend API are deployed separately with both ends matching and no duplicate bot Gateway workers.
- Approve isolated database migrations `hc_staff_factor_approvals.sql`, `hc_staff_totp.sql`, `hc_staff_security_invitations.sql` after first passkey acceptance. Startup preflight validates full credentials **before** connecting to PostgreSQL and refuses if required key or passkey state is missing.
- Run disposable PostgreSQL/HTTP tests and then a real owner browser + Authenticator device test: wrong bot key, wrong guild/channel, unsigned PIN session, invitation replay, absent/stale manager passkey, denied QR-before-approval, six-digit confirmation, active factor state, and failed reset/recovery.
- A passkey alone is not production authorization. Do not mount this test subsystem in live Lightspeed/Timeclock or enable real employee enrollment without a separate manager security review and explicit release approval.

## Development status
The composition, flags and guarded migration are implemented in the Phase 1 Lightspeed branch; Phase 2 source should be reconciled before any PR merge. Tests are `tests/shared-security-isolated-owner-enrollment.test.mjs`, `tests/shared-security-isolated-owner-approval*.test.mjs`, the existing full invitation/PostgreSQL QR→TOTP integration test, and first Owner WebAuthn tests.

**Not done:** human WebAuthn registration and recovery test, real Malcor invite, secret provisioning, real phone Authenticator acceptance, formal security approval, and a separately authorized staging deployment. No factor route is currently active.
