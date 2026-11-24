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


## Disposable PostgreSQL 18 schema/role acceptance — 2026-11-24

**Source milestone, not live DB provisioning.** Reuses the *existing*, reviewed seven SQL fixtures from `scripts/bootstrap-owner-stage-database.mjs` without calling its original-project-only provisioning entrypoint. Runs in a strictly local, ephemeral PostgreSQL 18 Docker container bound only to `127.0.0.1:15488`, with fixed cluster name `hc-secure-disposable-pg18` and fresh database `hc_owner_stage_test`. Refuses any Railway project/environment/service variables, nonlocal host or unexpected PG cluster/version. Verifies the nine Owner security tables, two `NOLOGIN` privilege groups, denied Owner activation INSERT/DELETE and approval-fact rewrites, permitted consumption/credential-column updates, operator-only INSERT and no operator TOTP SELECT. **Always ROLLBACK**, including success; never issues or copies Owner credentials.

**Codespace test (requires Docker daemon and npm dependencies):**
```bash
cd /workspaces/Lightspeed
git switch feature/hc-secure-staging-readiness-20261123
git pull --ff-only
node --test tests/hc-secure-disposable-schema.test.mjs
bash scripts/run-hc-secure-disposable-pg18.sh
```
The runner generates a random throwaway DB password locally, uses an in-memory PostgreSQL volume, runs the full real SQL/role test **twice**, and removes the Docker container automatically. Expected two lines `HC_SECURE_DISPOSABLE_SCHEMA_OK fixtures=7 tables=9 nonlogin_groups=2 rollback=true`, followed by `HC_SECURE_DISPOSABLE_PG18_DOUBLE_PASS=true`. **These tests are authored but have not been run yet.** A passing disposable test is required *before*, not a substitute for, separate database bootstrap/secret provisioning authorization.

**Important:** The original `db/hc_owner_staging_privilege_groups.sql` wraps its own `BEGIN`/`COMMIT`. The disposable test strips exactly those delimiters and refuses transaction control in other fixtures to guarantee outer rollback. Original Owner schema file and live databases remain unchanged. Tests cannot prove new-host WebAuthn credential continuity or employee MFA integration.



## New HC Secure-specific Railway DB bootstrap and locked-role gate — 2026-11-24

**Authoring only; do not execute on live Railway until a separate provisioning authorization.** The existing Owner one-shot DB scripts are pinned to a different Railway project and must never be reused for HC Secure. Two new explicit one-shot programs prepare the new project:

1. `scripts/bootstrap-hc-secure-staging-db.mjs` demands exact new project `120de974-f2e8-46be-9a00-8eb8b1be4cc4`, staging env `8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c`, separate offline service name `hc-secure-db-bootstrap-once` (not provisioned yet), `HC_SECURE_DB_BOOTSTRAP_ONLY=true`, operator action `HC_SECURE_DB_MUTATION_APPROVED=HC_SECURE_FRESH_DB_SCHEMA_ONLY`, independent root URL (postgres user, private `hc-secure-postgres-staging.railway.internal/railway`, nonblank 16+ character password) and no business/auth credentials. Requires PostgreSQL 18, zero existing `hc_owner_stage_test` DB and no existing HC Owner login or group roles. Creates a brand-new test DB, applies **seven reviewed Owner schema fixtures** in a controlled transaction with required nine tables, two NOLOGIN grant groups, restricted activation issuance, and zero Owner/activation rows. Never issues Owner activation. If DB creation succeeds but schema fails, leaves DB intact for explicit operator reconciliation; never drops/retries automatically.
2. `scripts/prepare-hc-secure-locked-roles.mjs` separately requires `HC_SECURE_ROLE_PREPARE_ONLY=true` and `HC_SECURE_DB_MUTATION_APPROVED=HC_SECURE_LOCKED_ROLES_ONLY`, exact same new project/environment/service and protected root URL; requires no existing Owner or activation rows, no existing login roles and correct NOLOGIN groups, then creates separate `hc_owner_stage_runtime` and `hc_owner_stage_operator` login roles with **PASSWORD NULL**, least-privilege non-overlapping memberships, verifies privileges, and commits. Does not set passwords and refuses to reissue first-Owner authority.

**Tests authored, not executed:** `tests/hc-secure-staging-bootstrap.test.mjs` (6 cases) and `tests/hc-secure-locked-roles.test.mjs` (5 cases). Mock-only, no external database connections. Run from Lightspeed Codespaces branch:
```bash
cd /workspaces/Lightspeed
git switch feature/hc-secure-staging-readiness-20261123
git pull --ff-only
node --test tests/hc-secure-staging-bootstrap.test.mjs tests/hc-secure-locked-roles.test.mjs
```
This must pass before additional source review and separate real Railway authorization.

**Deployment prerequisites still outstanding:** `HC Secure/staging` currently has *only staged-create* PostgreSQL 18 image/volume and guarded Owner app; no DB bootstrap password/variables, no privileged one-shot service or hardened network transport, no login secrets, dedicated authenticator encryption keys, signed employee security policy, newly registered WebAuthn credential for the new RP ID, or new custom domain/DNS/TLS. Do not accept Railway staged patch; provisioning code is not yet deployed or configured. A separate credential-commissioning milestone must generate independent runtime/operator passwords and verify access, deny incorrect credentials, and provide key custody without logging secrets. Do not copy original Owner secrets or registered WebAuthn rows.



## HC Secure separate credential-commissioning program — 2026-11-24

**Read-only preflight passed 4/4 based on operator Codespace report.** Implemented separately gated `scripts/commission-hc-secure-db-credentials.mjs` for independent role passwords. This uses the *new* HC Secure-only `verifyHcSecureCredentialCommissioningScope`, targets the private new PG18 `hc_owner_stage_test`, and refuses any existing Owners or activation records, old Owner project/DB or unexpected preconfigured/unlocked roles. It verifies restricted role memberships and cannot silently promote runtime to operator. Passwords must be distinct, generated out of band, never printed, and must not be copied from original Owner or business systems.

The program checks PostgreSQL 18 context, issues two parameter-format-constrained 48-character password assignments in a single SQL transaction (Postgres does not parameterize `ALTER ROLE PASSWORD`; preflight guarantees strictly ASCII alphanumeric), requires SCRAM-SHA-256 password hashes, commits, verifies runtime and operator login permissions, runs the existing runtime nine-table privilege gate, and verifies an intentionally incorrect password returns PostgreSQL auth error **28P01** (not a network error). If it fails before committing, it rolls back; if checks fail after committing, it attempts to relock both roles to `PASSWORD NULL` in a new transaction. Failed relocking requires incident review, not a retry. No First Owner activation or WebAuthn enrolment occurs here.

**Important:** This one-shot source is **NOT DEPLOYED**; no live credentials, DB or Railway services have been modified. Its tests are **new and not yet executed**. Additional security review is required before running it on real staging PG; particularly handling ambiguous network failures at COMMIT and ensuring roles are locked after failures. The new SQL schema/role provisioner is also not deployed.

Codespace test (mock-only):
```bash
cd /workspaces/Lightspeed
git switch feature/hc-secure-staging-readiness-20261123
git pull --ff-only
node --test tests/hc-secure-credential-commissioning.test.mjs
```
Six test cases: wrong project rejects before client, nonempty Owner/activation rows refuse, unlocked roles refuse, transactional rollback after partial update, relock after postcommit login failure, and reject network failure as wrong-password proof. **Do not set real Railway credential variables or run the live commissioning program for this test.**

