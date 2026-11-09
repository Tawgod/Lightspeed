# Primary Timeclock employee → Authenticator enrollment rollout

**2026-11-09 — In Development / CI tested / not mounted or deployed.**

## Goal
Enable an existing active Hobby Corner Timeclock employee to continue using the **existing** PIN and employee ID, request independent permission to enroll an authenticator, scan a newly issued employee-bound QR code, and use the resulting short-lived MFA session for routine store-tool access. Never transfer synthetic test employee 901 credentials or claim that the PIN itself establishes Owner authority.

## Source and implementation
- Draft PRs #39–#41 contain read-only self-identity, canonical Timeclock verification and strong-factor readiness checks. PR #42 introduces `primaryLiveTotpEnrollmentGate.js` and `primaryTimeclockTotpSubsystem.js`, **unmounted**.
- Reuse `createStaffAuthGateway.verifyBoundEmployee()` to validate signed base session (15-minute default) and active Timeclock record; `createTimeclockScannerIdentity.authorize(id)` rechecks the authoritative employee directory.
- `createStaffSecuritySubsystem` already implements PostgreSQL approval requests, independent manager approval, encrypted AES-256-GCM TOTP seeds, one-time confirmation, signed TOTP MFA sessions and factor recovery. The candidate composition wraps its session/approval callbacks; it does not implement a new user database or PIN flow.
- The first real Owner/approver credential still requires **independent** audited commissioning. Synthetic 901 passkeys, Discord role or any PIN alone cannot commission the first Owner.

## Required gates before a real QR code may be offered

1. **Canonical identity:** Privately sign in using the existing primary Timeclock PIN on a reviewed HTTPS service with the signed session gateway, and confirm the backend independently resolves the *same* active Timeclock employee ID. Never collect the PIN or OTP in GitHub, logs, Railway variables or chat.
2. **Trust separation:** Verify the live Timeclock service origin, backend-only service secret, proxy trust, rate limit, session binding and revocation behavior. Staging must not use the synthetic test identity for this acceptance. Never attach production employee credentials or production DB to the existing synthetic-only staging service.
3. **Owner commission:** Establish who may approve the *first* real Owner strong factor, using an independently documented secure identity proof/approval process with audit and recovery. Do **not** infer Owner status from Timeclock PIN, name, Discord role or Scanner canApprove. If no existing authorized strong approver exists, stop; do not self-approve.
4. **Infrastructure:** Review additive `hc_staff_totp.sql`, `hc_staff_factor_approvals.sql`, `hc_staff_auth_throttle.sql` migrations and audit tables. Verify disposable PostgreSQL integration tests, least-privilege DB roles, encrypted backups, separate 32-byte TOTP key/rotation/recovery custody, independent signing keys, and service rollback. Never execute schema changes on live databases without separate authorization.
5. **Enrollment approval:** The signed employee may request approval. A different independently verified active manager/Owner with fresh passkey/security key/approved IdP proof and exact `staff.authenticator.enroll` authorization must approve the **employee/session-bound request**. Confirm it is durable, rate-limited, single-use, expires promptly, and never accepts an employee ID from browser body.
6. **Browser and boundary:** Enforce HTTPS, reviewed same-origin/CSRF controls for requests that generate a QR or submit codes, CSP/no-store/no-referrer, strict request limits, protected server origin, and mobile/Chrome access without exposing raw API or signing keys.
7. **Live enrollment acceptance:** Verify a fresh primary-bound QR code appears only after approval; scan it in Google Authenticator; confirm a six-digit code privately in browser; check stored active status and backend MFA session binding; reject replay, expired session, wrong employee, revoked/inactive account, wrong device and guessed code. Do not log/display seed after enrollment. Backup recovery must be verified.
8. **Rollout:** Reconcile Admin, Shared Lightspeed and Timeclock security branches and full CI; coordinate legacy Timeclock/Chrome flows without breaking in-store clocking; obtain explicit owner approval for *each* live Railway/DB/prod change and deployment. Do not treat CI fixture tests as live-device acceptance.

## Security boundaries
- **Do not copy** the test employee 901 PIN, TOTP seed, passkey, grant or authenticator generation onto a real employee ID.
- The existing staff PIN remains the *identity credential*, not the sole authorization for an internet-facing tool or factor enrollment.
- Read/search tools can accept a fresh independently validated TOTP session plus an exact operation grant; sensitive product/PO/inventory/credit/admin writes continue to require stronger fresh passkey/security key/approved IdP proof, operation grants, durable audit and idempotency.
- Tool access is independent of time-clock state/shift; inactive/disabled employee status denies access.
- Do not activate the candidate route with a mock verification function, test secret, browser-provided Owner claim, or `canApprove:true`.

## Operator acceptance sequence
Once every gate is satisfied and the approved secure enrollment host is deployed:

1. In the browser, sign into the *primary* Timeclock-backed employee account with the existing PIN. No credentials need to be sent to ChatGPT.
2. Confirm the displayed verified employee identity matches the intended real employee (no role promotion is implied).
3. Request Authenticator enrollment. An authorized independently verified approver approves it through the secure manager flow.
4. Open Employee Security Settings, scan the **new** QR using Google Authenticator, then enter the six-digit code in the secure browser.
5. Confirm that the authenticator shows `active` and a fresh MFA session is accepted for routine reads; test sign-out, expiry and alternate-device behavior before broader rollout.

**Current stop condition:** no independently verified real Owner/approver commissioning, no live primary-employee browser acceptance and no approved production deployment. Therefore this is a development candidate, **not a working enrollment URL**.
