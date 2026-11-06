# Hobby Corner — Employee Security Settings (candidate)

**Status:** In Development / Testing, **not mounted or deployed**  
**Last reviewed:** 2026-10-30  
**Owners:** Shared Lightspeed Services; Shared UI/UX coordinates adoption; Timeclock remains employee authority; Deployment Coordination manages release.  
**Source:** PR #32 `feature/shared-lightspeed-services-phase1-20261029`; mirrored on draft stacked PR #33.

## Implemented candidate

- Responsive standalone web view: `staff-security.html`, `staff-security.css`, `staff-security-client.js`.
- Unmounted backend: `routes/staffSecuritySettings.js`; uses server-side employee session verifier and independent `authorizeSettings` check on **every** employee-specific API endpoint.
- `services/security/staffTotpPostgres.js` now supports `status({context})`, returning only `not_enrolled`, `pending` (expiry), or `active`; **never secrets, encrypted bytes, last-used counters or attempt counts**.
- Setup flow: Timeclock-signed employee session -> independently authorized enrollment -> ten-minute random encrypted TOTP factor -> **locally generated** QR PNG via the existing `bwip-js` package or manual 32-character Base32 key -> six-digit first-code confirmation -> active status.
- Responsive phone/tablet presentation, clear sign-out, enrollment expiry, accessible feedback, passkey (planned) and manager-controlled recovery guidance.
- Sensitive setup key/QR is returned only on protected enrollment; no external QR-generation service receives the seed. Browser code keeps it in memory only and clears the QR, setup key and code when the page becomes hidden, is left or signed out. Both web and API responses are `no-store` with restrictive CSP, referrer policy and frame denial.
- Existing `shared-ui/staff-auth.js` supplies *initial PIN-signed identity session*, **not** the independent permission for enrollment. The server-side authorization callback must verify a registered workstation or recent strong/manager-approved factor; a PIN-only session **must fail** enrollment.

## API contract, only if mounted by a separate approved release

Mount intended: `/staff-security`.

| Method | Relative path | Response | Required |
| --- | --- | --- | --- |
| GET | `/` | Static page with no employee data | No secret |
| GET | `/client.js`, `/styles.css` | Static same-origin assets | No secret |
| GET | `/api/authenticator` | `{state, expiresAtMs?}` | Current active Timeclock employee + independent settings assurance |
| POST | `/api/authenticator/enroll` | `{qrDataUrl,manualKey,expiresAtMs}` | Same, plus separately approved factor enrollment; empty JSON body only |
| POST | `/api/authenticator/confirm` | `{confirmed:true}` | Same + current six-digit code, enrollment state/expiry and server-side attempt limit |

No `GET` secret readback, factor reset/disable endpoint, public verify-code endpoint, arbitrary employee-ID selection, account recovery shortcut, QR external URL, or privileged Lightspeed write is exposed.

**Security interfaces required on integration:** `verifyEmployee(req)` must return a current active Timeclock employee from an already valid, signed session; `authorizeSettings({request,employee,action})` must verify **additional independent assurance** and operation grant; the `totp` adapter's `verifyEmployeeSession` and `authorizeEnrollment` must independently enforce server-owned identity/approved enrollment. Do not wire any callback directly to client headers, PIN-only claims, saved browser roles, or a manager-looking form field.

## Tests

- `tests/shared-staff-settings.test.mjs`: candidate route HTML, restrictive CSP and cache headers, session and independent enrollment-denial, forged browser claims, status secrecy, valid locally generated QR PNG, invalid/valid confirmation, and absent reset endpoint.
- `tests/shared-staff-totp-postgres.test.mjs`: disposable PostgreSQL 16; status metadata, encrypted seed storage, signed identity/manager approval dependency, one-time code consumption across clients and retry denial.
- Foundation CI checks these tests alongside existing Scanner, core operations and database regressions. A passing mock test is **not** employee browser acceptance.

## Remaining work (not claimed complete)

1. Choose actual approved workstation enrollment, employee-bound passkey/IdP MFA and verified manager enrollment/recovery rules; map them to the `authorizeSettings` and `authorizeEnrollment` backend callbacks. **Do not allow PIN-only self-enrollment.**
2. Design secure employee/device binding, short-lived step-up claim and session revocation; default-deny remote access before factors are properly registered.
3. Add a separate, audited, owner-approved factor recovery/replacement process. Do not allow factor reset from the same vulnerable four-digit PIN.
4. Integrate the settings route into the shared staff gateway **only after approval**; implement responsive navigation in coordination with Shared UI/UX. It is not in existing store navigation or Chrome Toolkit.
5. Harden legacy public Timeclock status/clock name/PIN routes with a coordinated Chrome/backend migration; do not disrupt existing employee clock in/out.
6. Review Railway ingress/proxy IP trust, anti-bot layer, actual employee authorization, optional mobile TOTP verification **plus signed MFA session exchange**, rate-limited retries, logout and offboarding.
7. Run real device/browser and lost-phone acceptance with store employees, confirm key custody and Postgres backup/restore, and seek explicit production integration/deployment authorization.

**Important:** This is a first usable candidate component, not a live settings page. The actual login/session and strong-factor provider integration is not yet wired; employees must not be directed to it in production.


## Verified Timeclock-to-MFA policy bridge candidate — 2026-11-02

New unmounted server-only module: services/security/staffSecurityBridge.js.
Its createStaffBoundSessionAdapter({staffAuth}) calls the existing
staffAuthGateway.verifyBoundEmployee verifier, rechecks active employee ID,
unique server-signed session binding and expiry, and exposes
verifyBaseSession for createStaffMfaSessions. It does **not** verify a
four-digit PIN from request fields or accept an employee/role from the browser.

createStaffSecurityAccessGate({staffSession,mfa,checkPermission,
verifyWorkstation?,verifyStrongStepUp?}) feeds the existing
staffAccessBaseline exact-operation policy. A request may present the
short-lived signed X-HC-MFA-Session token **alongside** the current
Timeclock signed session; the backend independently verifies the MFA
signature, bound session, employee status and active factor generation.
Verified TOTP may satisfy routine read/staging policy, but cannot enable
products/PO/inventory/sales/store-credit/staff-permission mutations.

Store workstation trust and stronger passkey/security-key/OIDC verification
are intentionally **injected server-side interfaces**, not fabricated by this
bridge. Omit either callback until its independent enrollment, signature/
IdP verification, revocation and cross-device tests are complete: the
corresponding assurance path then fails closed. The checkPermission callback
must consult backend grants for the precise operation. The module deliberately
does not mount staff routes, enable writes, apply schema, read a Railway secret
or change legacy Timeclock clock-in. Do not wire a request header/body/Origin
directly to either trusted callback.

Regression file: tests/shared-staff-bridge.test.mjs covers spoofed
headers, invalid Timeclock sessions, signed TOTP binding and revocation,
restricted writes, strong-factor/permission conjunction and failing
verification services. Phase 1 GitHub foundation CI run 41467459820
passed with this file explicitly included. Phase 2 contains mirrored code
and test, but its current-head CI must be checked independently.

**Next integration gate:** Implement and test real workstation challenge/
registration or independently verified passkey/IdP manager approval; confirm
Timeclock's current signed-session verifier is the sole employee authority;
repair legacy public clock/status authentication without breaking store
clocking; verify trustworthy proxy IP handling, mobile browser/Chrome employee
acceptance, secret custody, recovery, and staged database migrations. Only
then seek explicit deployment authorization.
