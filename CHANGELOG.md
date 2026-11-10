# Hobby Corner Lightspeed — Development Changelog

## 2026-11-06 — Employee Administration & Security foundation (development, unmounted)

- Created draft PR #34 on `feature/employee-admin-security-foundation-20261106`, stacked on shared services Phase 1 branch.
- Added a server-only administrator authentication gate requiring active employee session + recent passkey or TOTP + exact admin permission; privileged changes retain a separate strong step-up requirement.
- Added an extensible source-owned registry to gather all tool settings under one menu, while marking unconnected/unknown tool settings as planned or requiring audit.
- Added an inert responsive admin page with protected read-only discovery routes; no production auth bypass or write APIs.
- Added local/remote idle and absolute timeout validators, and an unapplied PostgreSQL versioned policy store with append-only audit.
- Added automated admission, HTTP/UX, registry and session-policy tests including disposable PostgreSQL.
- No production deployment, Timeclock/Lightspeed writes, extension package or active session policy changes.

## 2026-11-06 — Owner / delegated manager authorization

- Added Owner/delegated-admin permission catalog and durable PostgreSQL principals, explicit admin grants, per-tool operation scopes, per-tool settings scopes, employee tool grants and append-only authorization audit. No automatically granted Owner exists in production.
- Added administrator delegation store with strong-gated Owner-only admin grants; specific delegated manager onboarding, setting, and tool grant capabilities; active Timeclock target checks; prohibited self/Owner privilege mutations; and revocation of manager capabilities.
- Added read-only effective capabilities for server-filtered admin sections, Owner-visible role label, explicit owner permission-management forms and scoped manager tool grants.
- Added integration tests using disposable PostgreSQL and HTTP route checks for no admin access without grant, manager private-record restrictions, out-of-scope grants, unknown employee targets, and revocation.
- Changes remain on draft PR #34 only and are not mounted, deployed or authorized for live employee writes.

## 2026-11-06 — Isolated read-only administrator authentication integration

- Added synthetic isolated-staging admin browser entry using the existing signed staff PIN session followed by independently verified Google Authenticator or WebAuthn passkey. The browser holds proof in memory and discards it on page hide/sign-out.
- Added isolated test-only server-side composition with exact read-only `admin.read` / `tools.settings.read` grants for synthetic employee 901 and strong passkey/TOTP verification against the same bound session. New `HC_STAGING_ADMIN_READONLY_ENABLED` flag defaults off.
- Added read-only capability resolution to the admin metadata API, separating synthetic Owner preview from all real delegation mutation routes. No admin grant store, Timeclock employee writes or tool-setting writers are mounted in the preview.
- Added denial messages, login and factor controls, URL/Origin and forged-role rejection tests, no-write HTTP tests, and browser volatile proof tests.
- Security workflow [42293979612](https://github.com/Tawgod/Lightspeed/actions/runs/42293979612) **SUCCESS** after test-harness correction; no Railway deployment or feature flag activation.

## 2026-11-09 — Minimum employee directory with Timeclock-backed privacy

- Added optional employee directory API guarded by the independent `employees.directory.read` operation; `employees.private.read` controls separate private status fields. An employee with `employees.onboard` alone cannot enumerate existing employees.
- Added a non-mutating Timeclock employee-list endpoint with backend-only admin-secret check to avoid legacy roster GET's implicit Lightspeed sync.
- Added server-only validated Timeclock transport and minimal field projection; no raw PIN hash, Discord IDs, Lightspeed IDs or personal contact data is sent to basic directory consumers.
- Added a hidden, capability-filtered browser employee directory listing that requests records only when the verified server grants independent directory-read access. Current synthetic staging preview does not have that grant or the adapter.
- GitHub Actions Shared Lightspeed foundation `42665224213` and Scanner integration `42665224227` **SUCCESS** at functional/test commit `5fb9606b80cea8a63def3245c1b836cf8ae19317`.
- No admin/Timeclock production deployment, directory data access, employee edit, permission grant, PIN reset or extension release occurred.

## 2026-11-09 — Restricted onboarding, manager scopes, Owner review, policy previews

- Added a minimal, permission-gated and strong-factor-required new-hire request workflow. Manager access is limited to creating/viewing the manager's own requests, without private employee roster access. Request idempotency avoids duplicate creation on retries.
- Added a separately verified Owner-only new-hire review/decision flow; review approval does **not** provision a Timeclock/Lightspeed employee account. All requests and decisions have durable immutable audit events.
- Added server-side exact operation checks and a scoped employee-tool permission read interface for future integration. Production tool authorizers remain untouched.
- Added read-only local vs remote session policy preview against server-bounded rules. No settings-update endpoint is mounted, no Timeclock session TTL is changed, and no policy is deployed.
- Added opt-in/capability-gated admin UI panels and disposable PostgreSQL/HTTP tests to the Shared Lightspeed foundation workflow.
- Automated Shared Lightspeed foundation `42668508441` and Scanner regression `42668509091` **SUCCESS** at final functional/test commit `ef2776400451ce219b8d93d856ced302bde77436`. Later commits are documentation-only.
- No production or staging deployment, real Owner commissioning, live PIN/employee/permissions change, Timeclock API rollout or Chrome extension release.

## 2026-11-09 — Signed-session binding for operation authorization

- Removed any dependency on request-supplied employee ID for prospective exact tool-grant enforcement.
- Require a trusted signed-session verifier callback to resolve employee identity before evaluating the Timeclock active state and exact tool permission. Deny if unavailable.
- Expanded disposable PostgreSQL security test for signed-session binding and spoofed employee-ID denial.
- Shared foundation CI `42669190828` and Scanner regression `42669190918` both SUCCESS at functional commit `81a78d933711836b395c0d50e2dabcb118165ee0`.
- No deployment or production permission change.

## 2026-11-09 — Actual isolated Admin schema and restricted reader provisioning

- Added target-verified one-time schema migrator `scripts/admin-schema-isolated-once.mjs` with transaction, advisory lock, canonical Admin tables and empty principal/grant safeguards; isolated Railway deployment `d39bee4b-14cf-4c8a-ad8b-889c4301362b` **SUCCESS**.
- Added one-time `scripts/admin-nav-reader-isolated-once.mjs` provisioning an independently credentialed `hc_admin_nav_reader` LOGIN with SELECT-only table privileges; isolated deployment `b62b8f3b-6c5c-437c-989e-cd09a02cfd40` **SUCCESS**. Credential in Railway variables, not repository.
- Added unit/rollback tests; Shared foundation Actions `42681876995` and `42682795631`, Scanner `42681877056` and `42682795628`, Admin integration `42681876845` and `42682795964` SUCCESS.
- Separate read-only Railway smoke `2c1384c3-7080-4921-bad7-674572ed17d0` SUCCESS after elevated migration URL disabled. No Owner, manager, employee record or production grant was created; browser Admin navigation not deployed.


## 2026-11-09 — Primary Timeclock self-identity discovery (development, unmounted)

- Stacked draft PR #40 on primary security readiness PR #39; added `primaryEmployeeIdentityDiscovery.js` to separate first-time canonical employee identification from the independent Owner/strong-factor enrollment gate. No passkey is required for **read-only identification**, but identity discovery never authorizes credential registration or Owner appointment.
- `primaryTimeclockCanonicalReader.js` reuses the existing backend-only Timeclock Scanner authorization service. It requires a matching active Timeclock employee and trusted `timeclock_employee` provenance; clock-in state, Scanner approval and a client role cannot confer Owner permission.
- Added disabled-by-default `GET /self` router factory `routes/primaryEmployeeIdentity.js`, unmounted by any production or staging server. Returns only limited self-identification/readiness with no employee selector, login secret, factor transfer or write methods.
- Synthetic, revoked, expired, mismatched, role-spoofed and service-unavailable identity checks fail closed. Focused unit and HTTP tests and module syntax checks passed in GitHub Actions [42703689898](https://github.com/Tawgod/Lightspeed/actions/runs/42703689898) at `55092098a6daec7a2a731952d27172e7c77c01d3`.
- Neither real employee data nor primary PIN/passkey/TOTP records were read or modified. No schema migration, extension packaging, Railway change, factor enrollment, Owner grant, branch merge or production deployment occurred.


## 2026-11-09 — Primary Timeclock verification composition (development-only)

- Draft PR #41 stacked on read-only primary identity discovery PR #40 adds `services/security/primaryTimeclockVerificationWiring.js`, a backend factory that composes trusted signed-session verification, existing server-to-server Timeclock active-employee authorization, independent Owner appointment query and the self-only `GET /self` identity discovery router.
- The factory requires `environment:'test'` and a trusted explicit `enabled` flag; it is **not mounted** by operational or staging servers, does not inspect or modify the real primary employee account, and adds no credential, grant or employee write route. Synthetic employee 901 is kept separate.
- Added `tests/primary-timeclock-verification-wiring.test.mjs` and dedicated CI running this with all inherited primary identity/readiness tests. [GitHub Actions 42706021754](https://github.com/Tawgod/Lightspeed/actions/runs/42706021754) read-only integration and parse steps **SUCCESS** at implementation commit `4b6e8e06b57e95fb3db835c38c3688e33e4488c6`.
- Railway `Hobby Corner Integration Test/test/staff-security-staging` remains at successful deployment `41a3ee7d-6fb9-4ac1-9f5f-a27120f95256`, source `feature/employee-admin-security-foundation-20261106@21a44f4f06ebaacec3d005344faa89f8907feb46`. No verified private Timeclock integration configured on that synthetic-only staging service. Unrelated unapplied Admin Navigation patch `27985da3-a390-44bb-ae3f-00d08a2fa408` was not modified or accepted.
- The user's actual primary Timeclock account remains **unverified**; moving beyond fixtures requires separately authorized secure read-only acceptance with existing primary staff session and explicitly provisioned trusted Timeclock integration, then independently audited Owner commissioning and primary-bound factor enrollment/recovery.


## 2026-11-09 — Canonical primary Timeclock Authenticator enrollment gates (development, unmounted)

- Created draft PR #42, `feature/primary-live-totp-enrollment-gate-20261109`, stacked on tested primary identity PR #41.
- Added `services/security/primaryLiveTotpEnrollmentGate.js` to bind the existing signed Timeclock employee session to the same current active canonical Timeclock record on every factor operation. A synthetic staging identity, inactive/disabled account, revoked session, incorrect employee binding or offline Timeclock adapter fails closed. PIN/role/Scanner canApprove do not authorize enrollment.
- Added `services/security/primaryTimeclockTotpSubsystem.js`: **test-only, unmounted** wiring into the existing separately approved PostgreSQL enrollment, encrypted TOTP and signed MFA session subsystem. Requires independently verified fresh manager passkey/security key/approved IdP proof and exact approval/recovery grants; no Owner auto-commission, test-factor transfer, employee write route or PIN reset.
- Added focused tests, dedicated CI and `docs/PRIMARY_EMPLOYEE_AUTHENTICATOR_ROLLOUT.md` outlining secure real-account commissioning, key custody, migration review, live-device acceptance, recovery and approval gates. GitHub Actions `42709757349` **SUCCESS** on functional/test commit `22dc405f02c4e6a4ebca5a258c1f256ec428c986`.
- No real primary Timeclock user record queried, credentials read, QR issued, production/isolated Railway patch applied, DB schema migrated, branch merged or Chrome extension released. Existing synthetic employee 901 remains separate.


## 2026-11-09 — Independent approver enforcement and first-Owner readiness

- Draft PR #43 based on primary TOTP candidate PR #42 adds `services/security/independentPrimaryEnrollmentApproval.js`. It requires verified, current, independently enrolled passkey/security-key/managed MFA, authoritative active Timeclock records for actor **and** target, exact `staff.authenticator.enroll` permission, and different actor/target employees. PINs, TOTP-only approvals, synthetic staging roles and self-approval fail closed.
- `primaryTimeclockTotpSubsystem.js` now actually binds its existing PostgreSQL approval hooks through the independent approver gate. New read-only `preflight` reports whether an authorized distinct approver exists without creating an Owner, enrolling a factor or issuing a QR.
- GitHub Actions `42711042161` **SUCCESS** at functional SHA `2603ef4facdcd3cfc9bab43ca09119bff46e82b2` with the new policy tests and inherited candidate composition regressions.
- **First Owner commissioning remains blocked:** no real primary employee verification, audited independent Owner identification, authorized external approver, production factor credential or recovery decision exists. Do not bypass this with the isolated synthetic Owner's self-enrollment exception. Code remains unmounted; no production deployment, live DB/employee/credential change or Chrome release.


## 2026-11-09 — First real Owner independently authorized passkey commissioning (development)

- Added draft PR #44 stacked on primary enrollment PR #43. `db/hc_owner_commissioning.sql` is an **unapplied** short-lived independent approval and append-only audit schema. `services/security/firstOwnerCommissioning.js` is an **unmounted** callback designed for the existing passkey registration transaction, verifying canonical signed Timeclock employee identity and independently issued evidence, then consuming the approval, appointing first Owner and logging audit atomically.
- Added negative tests for expired/replayed/missing authorization, wrong/synthetic employee, unavailable DB and pre-existing Owner. GitHub Actions [42714947158](https://github.com/Tawgod/Lightspeed/actions/runs/42714947158) **SUCCESS** at source SHA `6ef9b33868e9197e6ff765bba4e8bf2eb3633829`.
- Operator runbook `docs/FIRST_OWNER_COMMISSIONING.md` specifies separate identity proofing, DB role separation, explicit deployment authorization, recovery and live acceptance. **No independent operator verifier or approval issuance is implemented**, and no real employee account, PIN, passkey, TOTP secret, schema or Railway service was modified.


## 2026-11-09 — Signed independent Owner commissioning evidence (development)

- Draft PR #45 adds `services/security/firstOwnerAttestation.js`, verifying a separately provisioned Ed25519 operator signature over a 30-minute, employee-bound first Owner commissioning approval. The corresponding **unapplied** DB schema now requires `evidence_signature`, and the first Owner passkey registration hook passes DB facts and signature through the verification callback.
- No operator signing key, approval issuance endpoint, identity provider, PIN bypass, Owner credential, approval record or live employee access was created. A configured signature **does not prove ownership without genuine independent verification** by the responsible operator.
- [GitHub Actions 42717728513](https://github.com/Tawgod/Lightspeed/actions/runs/42717728513) **SUCCESS** on security source SHA `e721b46a0d4870371715cc69f437e18343063048`, including valid/tampered/expired/wrong-key signature tests and earlier first-Owner transaction tests. Still unmounted/unmerged/undeployed.


## 2026-11-10 — First Owner signed passkey registration / disposable PostgreSQL (draft)

- In stacked [PR #50](https://github.com/Tawgod/Lightspeed/pull/50), repaired the previously malformed, duplicated `db/hc_owner_commissioning.sql`. The SQL was unapplied and is now covered by disposable PostgreSQL CI instead of only mocked JavaScript.
- Added `firstOwnerPasskeyRegistrationCandidate.js` to compose canonical signed Timeclock identity, independently signed offline Owner authorization, and existing verified WebAuthn registration with atomic passkey/Owner/audit transaction. **Unmounted, test-mode only, no operator approval issuer or live credentials.**
- Added `first-owner-passkey-registration-postgres.test.mjs`, including real PostgreSQL schema application, signed approval and one-time passkey + Owner grant, immutable event, denial paths, and **fault-injected audit INSERT failure with full rollback** of credential, Owner and consumed approval. [GitHub Actions #42835824260](https://github.com/Tawgod/Lightspeed/actions/runs/42835824260) **SUCCESS** at functional commit `71e0ce2647950036bdc46cfa4d9ea16a8b0bc7cc`; 20 tests passed, none skipped.
- Added `.devcontainer/` with Node22 + private disposable PostgreSQL16 for optional Codespaces testing, and `docs/FIRST_OWNER_CODESPACES_TESTING.md`. No Codespace was started or runtime validated through the connector, and no production DB/Railway/Chrome changes occurred.
- **Still blocked for live enrollment:** independent external Owner verification, real signed Timeclock user acceptance, audited offline operator signature issuance/key custody and minimal privileges, genuine device WebAuthn proof, recovery and approved deployment.


## 2026-11-10 — One-time operator-selected first Owner activation (draft)

- Added alternative first Owner activation process that uses an explicitly configured **existing active Timeclock employee ID** and private short-lived 32-byte operator-delivered activation token, rather than requiring external business ownership verification. The digest is stored in the proposed `hc_first_owner_activations` table; activation expires within 15 minutes.
- `services/security/operatorFirstOwnerPasskeyCandidate.js` is **unmounted and restricted to test mode**. It checks canonical signed Timeclock session, exact configured employee, valid unconsumed activation and empty Owner registry; after verified WebAuthn it atomically creates the passkey, Owner grant and immutable audit. It does not mint approval tokens or assign an employee based on a PIN.
- `tests/operator-first-owner-postgres.test.mjs` covers wrong/no token, wrong employee, audit-write failure rollback, replay protection and success in disposable Postgres. [Actions 42848285658](https://github.com/Tawgod/Lightspeed/actions/runs/42848285658) **SUCCESS: 4 tests passed, none skipped**.
- Draft [PR #53](https://github.com/Tawgod/Lightspeed/pull/53) is stacked on PR #50. Reconcile with multiple Owners PR #52 and the existing TOTP/employee Admin flow before any release. No live Owner, PIN, authenticators, operator activation secret, Railway or production change.
- Setup and release safety guide: `docs/FIRST_OWNER_OPERATOR_SETUP.md`. Real browser ceremony, protected token handling, actual Timeclock mapping, database privilege separation, TOTP verification/recovery and explicit live deployment authorization are outstanding.


## 2026-11-10 — Protected first-Owner browser enrollment (draft PR #54)

- Added unmounted `/owner-setup` HTTP candidate, standalone first-Owner page, native WebAuthn registration UI, and explicit isolated-test-only backend composition. Reuses existing signed Timeclock session and operator-selected one-time Owner activation; no new employee account or PIN replacement.
- Browser requests require exact Origin, same-origin fetch metadata, JSON shape, a 43-character activation secret header, strict challenge IDs and sanitized error responses. Static assets have CSP, no-store/referrer and anti-framing headers; tokens are not persisted in browser storage.
- Existing TOTP/Google Authenticator settings screen and subsystem discovered and retained for later connection, avoiding a duplicate enrollment system. First Owner self-setup must require a newly verified registered strong passkey, not a PIN-only or synthetic-manager approval.
- [Run 42852751541](https://github.com/Tawgod/Lightspeed/actions/runs/42852751541) **SUCCESS**, 7 tests passed/0 failed/0 skipped on functional source `c53e6ac846bacc6296f06474e6816cb27392a422` including HTTP route protections and disposable PostgreSQL first-Owner regression.
- See `docs/FIRST_OWNER_BROWSER_ENROLLMENT.md`. No real-browser passkey, actual employee lookup, live token, production URL, Railway deployment, schema migration, account promotion or Chrome extension change. PR #54 remains draft and stacked on #53; Admin #52 must be reconciled before release.
