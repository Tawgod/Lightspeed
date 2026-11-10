# Same-account Google Authenticator enrollment after Owner passkey

**Status 2026-11-10: Development only.** This work is in draft PR #55 stacked on browser PR #54, operator activation PR #53, and first-passkey PR #50.

Hobby Corner's real primary Owner retains the existing Timeclock employee ID and four-digit PIN. Once the exact account has been operator-commissioned and a passkey is registered, the Owner may use that fresh, authenticated passkey to approve **their own** first Google Authenticator enrollment. An external business ownership verification provider or second manager's passkey is not a requirement for this first-Owner UX.

The implementation deliberately reuses `createStaffSecuritySubsystem` and `staff-security.html`; it does **not** introduce another TOTP table, second employee account, or alternative QR generator.

## Existing verification boundaries

- `createOwnerPasskeyTotpEnrollmentCandidate` is unmounted and refuses production mode. The expected Owner employee ID is configured by trusted deployment administration, not read from the browser.
- The underlying signed staff session is independently checked against the canonical active Timeclock employee record.
- The passkey proof must be issued by the existing registered WebAuthn service, employee/session-bound, fresh (within five minutes), and match the exact configured Owner.
- PostgreSQL must confirm that the principal is presently an active `owner`. A PIN-only/TOTP-only or revoked Owner cannot approve their own security enrollment.
- The durable, five-minute employee enrollment request, short-lived approved/start/finish states, 10-minute encrypted TOTP QR, six-digit code confirmation, replay prevention and throttling remain in the existing subsystem. Recovery is disabled in this first-Owner candidate pending a separate reviewed strong recovery path.
- The existing Staff Security page can request an enrollment and show the QR/confirmation, but still needs an Owner-specific way to obtain and submit a fresh passkey proof to its `enrollment-approve` endpoint. Never add a client-side Owner role checkbox or PIN-only approval.

## Before connecting to the live account

- Confirm actual real Timeclock employee mapping privately in a protected deployed backend; never ask for a real PIN, setup token, QR key or six-digit OTP in ChatGPT.
- Connect genuine device passkey authentication (not a mock) to the Owner's existing session, and expose the current secured approval route with same-origin/CSRF checks and full audit.
- Verify the existing encrypted factor schema and independent 32-byte keys, database role grants, recovery, real-phone Google Authenticator scan, code confirmation, revocation and backup.
- Reconcile multi-Owner Admin PR #52 with first-Owner branches PRs #50/#53/#54/#55 before deployment. Ensure later Owners can enroll their own factors with appropriately governed grants rather than inheriting the first Owner activation token.
- Run full mandatory PR/security checks, request explicit authorization for each production migration, admin role grant and deployment.

No production services, PINs, employees, factor secrets, Railway or Chrome extension were modified.
