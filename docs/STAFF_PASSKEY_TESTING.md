# Hobby Corner — Employee and Manager Passkey Candidate

**Status:** In Development / Testing, **unmounted**, **not deployed**. 2026-11-02.
**Source:** Phase 1 PR #32, mirrored to stacked draft Phase 2 PR #33. Timeclock remains the employee identity authority.

## Authentication boundary

A Timeclock PIN session alone **cannot** create a passkey, authorize a manager, or grant sensitive tool writes. The browser sends its current signed Timeclock session and WebAuthn requests only. All identity, enrollment permissions, active-employee checks, challenge consumption, credential counters and per-operation grants must be enforced by backend services.

- `services/security/staffPasskeysPostgres.js` uses **pinned** `@simplewebauthn/server@14.0.3` to generate options and verify registration and authentication, including exact configured HTTPS origin/RP ID, cryptographic challenge and required user verification. No custom authenticator signature verifier was written.
- `db/hc_staff_passkeys.sql` is an **unapplied**, additive schema for employee-bound public keys, counters, transport metadata, generation/revocation, 90-second one-time session-bound challenges and append-only credential event audit. Never store private keys or a raw PIN/session.
- `routes/staffPasskey.js` is explicitly **unmounted**, supplying `POST /registration/options`, `POST /registration/verify`, `POST /authentication/options`, `POST /authentication/verify`, and `GET /session`. All responses are no-store and no privileged write or public registration/approval shortcut is exposed.
- The same unmounted router serves `/`, `/client.js` and `/styles.css` from `staff-passkey.html`, `staff-passkey-client.js`, and `staff-passkey.css` for an **isolated manual browser pilot**. Native `navigator.credentials.create/get` are used without third-party scripts; no tokens or PINs are persisted in localStorage/sessionStorage. The pilot page can submit a manager's verified passkey proof to the existing enrollment-request approval route, **only after** that route is separately wired to this backend verifier and exact manager grants.
- A successful passkey assertion returns a signed, five-minute, Timeclock-employee/session/credential-generation-bound `X-HC-Passkey-Proof` claim. Its backend verifier checks the active Timeclock employee and current credential revocation state on every call. A PIN or forged `Origin`, role, device or MFA header is insufficient.
- The existing `staffSecuritySubsystem` manager-approval callback can be supplied from `passkeys.verifyStrongManager`; `createStaffSecurityAccessGate` strong-step-up callback can be supplied from `passkeys.verifyStepUp`. The hosting service must still provide independently managed exact permission grants. Neither adapter is enabled on any live route.

## The first owner/manager passkey: explicit bootstrap gate

There is no way to trust the first privileged passkey based solely on the existing four-digit Timeclock PIN. Do **not** create a public "make me manager" or PIN-only passkey enrollment endpoint. Before a manual test or rollout, the owner and Deployment Coordination must approve a private, independently authenticated bootstrap ceremony (for example an owner-controlled, audited, one-time operation with strong external identity verification and isolated test-environment access). The `authorizeRegistration({context,employeeId,phase})` callback deliberately **fails closed unless the hosting backend supplies such an independently verified grant**, on both `begin` and `complete`. Subsequent manager-approved enrollments must be audited, scoped to the actual employee and short-lived. A manager's own registration/replacement must not bypass the independent recovery policy.

Manager approval of Authenticator enrollment requires `verifyStrongManager` to return a fresh, backend-verified passkey assertion for the acting manager and `canApproveEnrollment` to grant `staff.authenticator.enroll` for the intended employee. That proof does **not** automatically grant general product/PO/inventory/credit writes.

## Automated test evidence and limitations

Run only with a disposable PostgreSQL 16 `hc_test` database, never Railway production:

```bash
HC_TEST_DATABASE_URL=postgres://hc_test:hc_test@127.0.0.1:5432/hc_test \
 node --test --test-concurrency=1 tests/shared-staff-passkeys-postgres.test.mjs
node --test tests/shared-staff-passkey-client.test.mjs
```

The PostgreSQL/localhost HTTP test uses actual P-256/ES256 cryptographic WebAuthn **authentication** signatures verified by SimpleWebAuthn, checks an origin mismatch, consumes failed/replayed challenges, binds sessions, updates counters, requires exact write permission and invalidates proof after credential revocation. **Registration verifier evidence is synthetic**: a controlled fixture supplies verified credential material for the registration step. This does not establish that an actual iPhone, Android phone or security key can complete browser credential registration against the server. The browser-client VM test exercises binary conversion and UI fetches, not hardware biometrics.

## Remaining tests before staff-visible rollout

1. Owner-approved independent initial passkey bootstrap, backup key and manager-only audited enrollment authorization. No PIN-only fallback or uncontrolled self-service reset.
2. Real browser WebAuthn registration and authentication with iPhone/iPad Safari, Android Chrome, Windows/macOS Chrome/security keys on a separately protected **HTTPS test origin and matching RP ID**. An authenticator registered for localhost is not valid for the production domain.
3. Verified manager test: manager passkey approves an employee's Timeclock-bound Authenticator request via existing settings service; verify forged headers, missing exact grant, offboarding, expiration, replay and lost-device recovery.
4. Determine authenticated test account and reliable `req.ip` behavior behind Railway/proxy and WAF. Durable per-employee/source throttle and edge bot protection must cover every credential-verification endpoint.
5. Review browser token-in-memory lifecycle, same-origin policy, CSRF/CORS, PostgreSQL migration/backup, credential integrity, attestation policy and operational revoke/backup process.
6. Coordinate remediation of legacy public Timeclock clock/status routes without breaking store clock-in. Do not attach the pilot UI to production navigation, publish extension code or merge PRs without explicit separate release authorization.
7. Review Phase 2 stacked ancestry and retest after any eventual coordinated integration.

Official engineering references: https://simplewebauthn.dev/docs/packages/server and https://developers.google.com/identity/passkeys/developer-guides/server-authentication.

**No live passwords/PINs, employee credentials, Railway variables or database content were read or modified.**

## Verified manager approval integration — 2026-11-02

- The disposable-PostgreSQL HTTP test now uses a **real WebAuthn P-256 authentication assertion** to obtain a manager's server-signed proof, then wires `passkeys.verifyStrongManager` into the existing `createStaffSecuritySubsystem` as its independent manager verifier.
- A **different** synthetic employee submits an Authenticator enrollment request through `staffSecuritySettings.js`. A manager PIN session with forged `X-Employee-Role` cannot approve. The manager's passkey proof **and** a separate exact `staff.authenticator.enroll` server permission can approve the request; the employee may then start TOTP enrollment. These test flows do not create any real manager/employee factors.
- The native browser pilot `staff-passkey.html` keeps both signed employee and passkey tokens in memory, uses `navigator.credentials.create/get`, supports the above manager-approval action, and intentionally has no self-service first-passkey bootstrap.
- Latest verified Phase 1 foundation run `41474392635` **PASS**, Scanner `41474392499` **PASS**, Core Operations `41474392819` **PASS** at test head `024fca591618ae7c15c1c4b934527a2ee4a3b589`. Phase 2 branch is mirrored but its latest-head CI has not been independently verified.
- **Important limitations remain:** actual browser registration/biometric acceptance and truly independently authenticated first-owner bootstrap are NOT covered by these synthetic test identities. WebAuthn registration verifier is still simulated by a test fixture; authentication signature verification uses the real library. Do not mount or deploy based only on this CI.
