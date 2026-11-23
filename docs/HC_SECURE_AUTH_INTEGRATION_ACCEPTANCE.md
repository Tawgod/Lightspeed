# HC Secure — Credential Continuity and Cross-Service Authentication Acceptance

**Date:** 2026-11-23  
**Status:** In Development / Testing not completed; no production security rollout.

## Host and credentials

- Approved HC Secure login origin: `https://secure-hc.timcorp-productions.com`.
- Approved HC Secure WebAuthn relying-party identifier (RP ID): `secure-hc.timcorp-productions.com`.
- Old *working* origin and RP ID: `https://hc-owner-staging-staging.up.railway.app` / `hc-owner-staging-staging.up.railway.app`.
- Existing registered passkeys are cryptographically associated with their old RP ID. An unchanged PostgreSQL credential row cannot be asserted at a different RP ID.
- Never accept untrusted `Host`, `Origin`, `X-Forwarded-Host`, browser employee/Owner-role headers, or a cookie from the wrong host as an authority to issue a new credential. Keep HTTPS-only, exact origin, CSRF checks, and short-lived signed sessions.
- Safest first test is a *fresh* Owner passkey and Authenticator login on the **old unchanged original host**. This confirms current credential health without changing state. New-host continuity requires a separately reviewed two-origin verified handoff or a new passkey registration at the approved HC Secure hostname after authentication, including private audit and anti-replay. No automatic enrollment by employee PIN alone.
- The external gateway must not translate assertion RP IDs or claim that a passkey registered for a Railway subdomain belongs to timcorp-productions.com.
- Customer accounts will require separate realm, session audience, rate limits, recovery, consent, account binding and application permissions. No access to Timeclock, Owner bootstrap, or Lightspeed administration simply by registering as a customer.

## Original Owner confirmation (user interaction required)

1. Open `https://hc-owner-staging-staging.up.railway.app/staff-security/` in the browser where passkey registered.
2. Fresh Timeclock PIN sign-in. `/api/staff-auth/session` should succeed, without exposing PIN.
3. Initiate `/staff-passkey` passkey authentication with registered device; require verification by browser/OS. A new signed passkey proof should be issued, never logged.
4. Complete a fresh 6-digit TOTP session verification and then `GET /staff-security/api/mfa/session` using same signed session. Expect authenticated server response; never screenshot QR or share TOTP.
5. Verify invalid/stale factor codes fail; check session expires, server-side revocation rules, wrong origin CSRF and wrong employee denial in controlled tests.
6. Record only pass/fail and non-secret HTTP status in handoff. The original successful HTTP-200 evidence from Nov 23 is a historical milestone, not a substitute for this new test.

## Central staging pre-deploy gates

- HC Secure/staging project `120de974-f2e8-46be-9a00-8eb8b1be4cc4` must have independent dedicated DB, correct role/schema, distinct sensitive keys, exact new URL/RP ID, and approved canonical Timeclock connectivity. **Never point new server at original live Owner DB as a shortcut**.
- **Currently staged only:** `hc-secure-auth-staging` at pinned source `977f63b267f226a29b731541386d492bb537c312`, Postgres 18 dedicated service and 5GB volume. No app/DB deployed, no env secrets, domains or credentials migrated.
- Current Owner source self-approval is restricted to canonical Owner employee. New staff accounts require explicit manager/Owner approval and independent Timeclock verification; do not widen Owner-only policy by bypassing employee identity and fresh passkey proof.
- Run `node --test tests/hc-secure-staging-readiness.test.mjs` on branch `feature/hc-secure-staging-readiness-20261123`. Source code tests are configuration-only and cannot prove physical device or database migrations.
- Once staging can safely boot, check DB roles/permissions, HTTPS cert, exact RP origin, registered test credential, MFA verification, replay/CSRF/wrong-user denial, session expiry and physical phone/browser flow. Maintain old host and audit until accepted.
- New target hostname DNS and gateway are NOT changed before deployment/acceptance review; do not blindly commit pending Railway patch.

## Cross-application employee security readback (production only, no changes)

| Production app | Source and active auth evidence | Current status / remaining integration |
| --- | --- | --- |
| Timeclock | `Tawgod/Lightspeed:feature/owner-timeclock-scoped-credential-20261110` deployed at `a595fd336c5a38dcc5ab5423a8967698777c0929`; existing canonical PIN/Owner staging integration endpoints | Deployed. Keep existing staff clock-in, Admin service integrations, permission/revocation semantics and credentials; do not change while HC Secure staging is incomplete |
| Special Orders (`special-orders-test` is **production**) | `Tawgod/Lightspeed:integration/hobby-corner-consolidation` deployed; `server.js` enables `/api/staff-auth` when scanner enabled, uses Timeclock PIN signed session through `createStaffAuthGateway`; scanner-specific secrets | Existing PIN session deployed, NOT verified to enforce new strong factor for all protected routes. Requires route-by-route grants and browser migration; preserve workers and call sites |
| Lightspeed API | Same consolidation branch; fewer security variables, no scanner session secret observed | No reason to claim new shared MFA currently enforced. Needs exact route and service-caller review |
| Store Map | `Tawgod/Lightspeed:store-map-production`; separate source and service | No confirmed shared staff MFA integration. Inspect protected actions and embed navigation/permissions as appropriate |
| Rewards + Discord Bot | `Tawgod/Hobby-Corner-Discord-Bot:main` deployed as distinct worker/API | Machine-to-machine operations must use independently scoped service identities; never pass human PIN/passkey/TOTP to unattended jobs |
| Old synthetic `staff-security-staging` | `Tawgod/Lightspeed:feature/employee-admin-security-foundation-20261106`, old isolated test DB and synthetic login | Testing only; does not substitute for live employees/Owner. Preserve until canonical staff cases verified |

**Known legacy compatibility:** deployed `shared-ui/staff-auth.js` still adds `x-hobby-corner-key` header when legacy key exists. **Do not remove globally until all callers and the backend are migrated and tested.** Source-only authorization proposals in `integration/security-all-tools-20261111` are not evidence of production rollout.

## Ordered reactivation of tool development

1. Verify original Owner passkey+TOTP still works through authentic device and Railway HTTP status (non-secret only).
2. Complete HC Secure isolated staging DB+secrets+new host setup without original database/credential destructive change.
3. Implement and test canonical non-Owner staff enrollment, approval, reset/revocation, and anti-privilege-escalation on HC Secure staging; keep synthetic tests isolated.
4. Inventory exact protected APIs, browser fetch calls, Chrome extension, Timeclock, Discord bot and Rewards service accounts; classify **employee user** vs **backend service** and granular permissions.
5. Test live-path compatibility with default-off strong factor gate, then stage controlled route-by-route rollout; no production deploy or DNS cutover until security owner approves tested changes.
6. Validate operating workflows: Timeclock, Special Orders, scanner, ordering, preorders, rewards, product sync, store map; monitor failures and preserve rollbacks.

## Evidence & safeguards

- Never print/store user PIN, QR, secret, recovery code, TOTP, WebAuthn private-key material, database URLs or plaintext environment variables.
- No GitHub Actions unless required; prefer focused Node tests and disposable PostgreSQL/browser validation.
- Health 200 alone isn't proof of registered factors, and successful deployment alone isn't proof of staff auth rollout.
- Do not issue another first Owner activation or second recovery grant; registration already completed.
