# Owner activation browser — current integration handoff

**2026-11-10 — In Development / verified HTTP + disposable PostgreSQL; unmounted.**

## User workflow
Preserve the existing Timeclock employee ID and four-digit PIN. A trusted operator identifies that active canonical employee ID and supplies a private, random 32-byte, one-time activation code. The owner signs into their Timeclock session and registers a WebAuthn passkey from the protected Owner setup page. There is no external business-ownership verification provider. The existing Staff Security Settings UI is the next integration for Google Authenticator on the same employee ID.

## Files and roles
- `owner-setup/index.html`, `owner-setup/styles.css`, `owner-setup/client.js`: guided first-Owner session and native browser passkey ceremony. PIN and activation form fields are cleared; signed employee session remains only in JS memory and is cleared on signout/page exit. No browser local/session storage, URL query secret, QR code, or logging.
- `routes/firstOwnerActivation.js`: **unmounted** route with exact HTTPS origin (test-only localhost exception), mandatory `Origin`, `Sec-Fetch-Site: same-origin`, JSON, protected activation header, bounded request bodies, sanitized errors, same-origin CSP scripts/styles, anti-framing and no-store headers. Route delegates to verified backend; it never accepts an employee ID or role from a request.
- `services/security/isolatedFirstOwnerSetup.js`: **test-only** assembly binds the activation header to `createOperatorFirstOwnerPasskeyCandidate`, which independently rechecks canonical signed Timeclock session, operator-configured employee ID and one-time activation. Production mode deliberately throws. No operator secret issuance API.
- Underlying PR #53 retains the disposable PostgreSQL activation table, 15-minute expiry, transaction-wide Owner+passkey+audit commit, challenge replay prevention and fail-closed missing/wrong approvals.
- `tests/first-owner-activation-router.test.mjs`: HTTP security contract for origin/secret/shape denial, static page, sanitized backend errors and mandatory test mode.
- [GitHub Actions 42852751541](https://github.com/Tawgod/Lightspeed/actions/runs/42852751541) **SUCCESS** on functional commit `c53e6ac846bacc6296f06474e6816cb27392a422`: **7 tests passed, 0 failed, 0 skipped**, comprising browser-route HTTP contracts and existing disposable PostgreSQL first Owner passkey transactions. These HTTP tests use a stubbed backend, and DB tests use mocked WebAuthn verification; no real phone passkey was exercised.

## Required before real account enrollment
1. Reconcile this stacked branch (PR #54) with PR #53 and multi-Owner Admin PR #52. Drop the old one-Owner index where appropriate, preserve first-Owner exclusivity, and verify required CI.
2. Approved configuration of actual canonical Timeclock employee ID via a private backend read, not a browser input. Preserve the real PIN; never copy from synthetic employee 901.
3. Operator-side cryptographic secret issuance and private delivery, strict DB INSERT/SELECT/limited UPDATE privileges, no token in logs; 15-minute expiry and one-use enforced. Review reverse-proxy `Origin`/fetch metadata handling.
4. Secure HTTPS staging domain with correct WebAuthn RP ID, actual Timeclock signed session and real passkey user verification, CSRF/same-origin controls, rate limiting and safe failure/recovery handling.
5. Review and connect existing `staff-security.html`/router + encrypted PostgreSQL TOTP subsystem. Its current approval UX expects a manager; for the first Owner, use a fresh registered passkey plus reviewed exact backend permission, not another Owner's approval or PIN-only enrollment. Verify QR, six-digit confirmation, recovery and factor revocation without moving the employee to a new account.
6. Finish protected Admin UI Owner grant action, review final-Owner protections, deployment/rollback plan and expressly authorize each live database migration, Railway deployment and real Owner assignment.

No production changes or merge/deploy were made by this milestone.
