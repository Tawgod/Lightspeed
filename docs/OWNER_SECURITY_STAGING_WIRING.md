# Hobby Corner Owner Security — Isolated Staging Wiring

Verified 2026-11-10. **In Development / unmounted / undeployed**.

## Implementation
Draft PR #57, branch `feature/owner-staging-wiring-20261110`, based on unified security PR #56. Adds `services/security/ownerSecurityStagingMount.js` to connect the previously isolated first Owner passkey registration to later WebAuthn authentication and the existing Google Authenticator enrollment service on one host. It reuses the **same** credential persistence, session binding and signed proof verifier.

Mount contract (only within an explicitly enabled, isolated `environment:'test'` composition with independently reviewed adapters):

- `/api/staff-auth`: caller-supplied **real canonical Timeclock** signed employee login router; never a synthetic PIN route.
- `/owner-setup`: first Owner passkey registration with operator-selected exact active employee ID, 15-minute one-use activation and atomic Owner/audit grant.
- `/staff-passkey`: post-registration WebAuthn authentication and short-lived signed proof validation, using the same database and signing secret as enrollment. No unauthorized passkey revocation exposed.
- `/staff-security`: **existing** encrypted TOTP staff settings, existing request/approval/QR/six-digit confirmation; first Owner may approve their own request only with verified fresh passkey and current active Owner role.
- `/shared-ui/staff-auth.js`: **isolated memory-only** login bridge for the existing security settings client. This overrides the general shared UI's sessionStorage / legacy-key fallback; base session exists only until tab unload and is never stored in web storage.

All mutating routes require the configured exact HTTPS `Origin` and `Sec-Fetch-Site: same-origin`. Fail startup without real adapters, a configured non-synthetic canonical employee ID, correct HTTPS host and RP ID. Production mode, no signed employee gateway, and known synthetic staging ID 901 are explicitly rejected.

## Verified scope
- Existing first Owner, multi-Owner delegation, passkey, session and TOTP suites remain covered by the combined disposable PostgreSQL 16 CI.
- Added HTTP checks for missing/malformed origin, forbidden synthetic Owner ID, no identity adapter, native passkey authentication route reuse, public setup screen and memory-only login bridge.
- The backend tests use fixture identities and mocked WebAuthn; this is **not** evidence that a real passkey device, actual Timeclock account or reverse proxy works.

## Dependencies before an actual user can enroll
1. Identify the correct **existing real Timeclock employee ID** through authorized, read-only canonical server lookup and validate signed employee session and revocation. Do not submit PIN, activation, QR, TOTP seed, private WebAuthn data or actual identity details in ChatGPT.
2. Implement/review the server-side operator-controlled one-time activation issuance: random 32-byte secret, digest-only DB storage, separate issuance/runtime roles, private delivery, 15-minute expiry and audit. No public API to create an initial Owner.
3. Review HTTPS domain and WebAuthn RP ID and trusted proxy origin/header behavior. Run browser Playwright and physical security key/phone tests. All CGI/HTTP guards and rate limits must be checked against actual staging reverse proxy, not just mock headers.
4. Review TOTP keys, staging and production Postgres migration privileges, logging, recovery and DB rollback; the first factor QR should not be exposed without fresh existing Owner passkey proof.
5. Reconcile draft PR #57 with upstream #56 and the broader Admin/Timeclock integration branch; ensure required checks before a production merge. Add secure real-device acceptance and factor recovery plan.
6. A new isolated staged service might be created only with **explicit user authorization** after confirming it uses no shared production data or synthetic test credential. Nothing here changes the existing Railway `staff-security-staging` deployment.
7. Before any live Owner promotion, apply only reviewed migrations with explicit approval and verify backups and recovery; keep the existing Timeclock PIN unchanged.

**Status:** Implementation drafted; automated CI confirmation recorded in PR #57. No real-user URL, database change, Railway deployment, production migration, employee role change, or Chrome extension release.
