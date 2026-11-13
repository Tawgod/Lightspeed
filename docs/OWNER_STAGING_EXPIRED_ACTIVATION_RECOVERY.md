# Staging First Owner — Expired Activation Recovery (draft, 2026-11-13)

**Status: Testing (3/4 tests initially passed). Recovery PostgreSQL integration NOT YET VERIFIED; NO staging migration or deploy.**
**Owner account: canonical Timeclock employee 1 only (operator-selected).**

## Evidence and reason

From the trusted operator's read-only Codespaces SQL output in isolated
`HC PR63 Isolated Staging/staging`, database `hc_owner_stage_test`:
the employee-1 authorization is expired, unconsumed, has no recorded passkey,
and the Owner count is zero. The exact timestamps/issuer are not verified
independently. The currently deployed Owner app reports `ready:true`;
Codespaces confirmed public page/client.js HTTP 200 and two negative POSTs
HTTP 403 (cross-site and missing activation). This does **not** prove
successful signed Timeclock verification, passkey registration, or TOTP.

The existing operator CLI intentionally prevents a second INSERT whenever
`hc_first_owner_activations` is nonempty. Its operator database role has
`SELECT, INSERT` only (not arbitrary `UPDATE/DELETE`). Do not delete,
truncate, overwrite, clone or change role grants to bypass that limit.

## Development candidate

- `db/hc_owner_stage_expired_activation_recovery.sql`: isolated-database-only,
  additive audit table, immutable audit trigger and one narrow
  `SECURITY DEFINER` function. Existing operator group gets only EXECUTE
  on the function and SELECT on its SHA-256 audit; **runtime gets nothing**.
  The function serializes with the existing Owner bootstrap/registration
  advisory lock and verifies exactly one old activation, expired and unused,
  no existing admin principal, no activation event, no staff passkey for the
  selected employee, and no previous recovery. It requires a new distinct
  SHA-256 digest and stores the original approval, issuer, timestamps and
  digest in an append-only audit. It sets a server-clock 10-minute expiry.
  Failed/audit-error transactions roll back both audit and approval.
  The one recovery is irreversible in history and cannot be issued twice.
- `scripts/issue-owner-stage-activation.mjs`: preserves
  `--issue-staging-owner` first-use behavior. Adds a separate private flag,
  `--reissue-expired-staging-owner`, gated by interactive TTY, isolated-stage
  environment, private operator DB identity, canonical Timeclock
  `authorize` and exact employee confirmation, plus an explicit
  `HC_OWNER_OPERATOR_RECOVERY_ACK` acknowledgement. No browser endpoint
  can issue or reissue an authorization. This is a human-only ceremony.
- `tests/owner-expired-activation-recovery.test.mjs`: always-on static/
  non-TTY negative checks. Additional actual-PostgreSQL test is explicit
  opt-in and requires a local throwaway `hc_test` PostgreSQL server.
  It refuses any non-local or existing Owner staging database. Covers
  unexpired/consumed grants, existing Owner/passkey, privilege separation,
  audit failure atomic rollback, immutable history and single recovery.

This is intended to be proposed as a **draft PR** based on the existing
Owner staging branch, not merged into live or production sources.

## Disposable Codespaces test evidence — 2026-11-13

The operator ran `bash scripts/test-owner-recovery-disposable.sh` in the
remote Codespace using a disposable `postgres:18` Docker container.
Tests **3 passed / 1 failed** (0 skipped). Non-TTY operator refusal and
source-level recovery invariants passed. The actual PostgreSQL recovery
test failed with `terminating connection due to administrator command`.
This does **not** validate the migration or recovery policy.

Possible causes include the Docker image's temporary initialization database
server being mistaken for its final PostgreSQL TCP listener, or forceful
test teardown masking the original failure. The branch now probes TCP
readiness twice (including after settling) instead of trusting in-container
`pg_isready`, and removes `DROP DATABASE ... WITH (FORCE)` in the disposable
test. The test also reports its failing phase and keeps the first SQL error.
These are **code changes only**, not evidence that the test is fixed.

Re-run the same disposable Codespaces test command on the latest branch
before reviewing the migration for deployment. Do not point the runner or
its URL at Railway or another non-disposable DB.

## Required gates before live staging database migration

1. Independently review current source, exact database and actual deployed
   code version/branch (the staging app is still source-pinned to
   `60cefaf71d7b737753728f95f8474df17e99912c` until proven otherwise).
2. Verify recent recoverable **staging** backup, precise target Railway
   project `5b46096d-3178-47ec-ba88-d5037696346a`, staging environment
   `46b93c76-3085-4e76-a37d-90dfdd250dd2`, database
   `hc_owner_stage_test` and restricted operator/runtime login roles.
3. In the owner Codespace, with dependencies installed, run **`bash scripts/test-owner-recovery-disposable.sh`** from the repository root. The helper starts a throwaway Docker PostgreSQL 18 on loopback in the remote Codespace, runs static and actual database tests, and removes the container on exit. It does not use Railway or the Windows workstation database. It requires Docker to be available in Codespaces. Use only a disposable local PostgreSQL 18 instance and explicit
   `HC_OWNER_RECOVERY_DB_TEST=1` to run the integration test. Its
   `HC_TEST_DATABASE_URL` MUST target `hc_test` on loopback; the test creates
   and drops a **new**, initially nonexistent `hc_owner_stage_test`
   database in that disposable instance. Never point the test at Railway.
4. Inspect SQL in detail and obtain explicit user authorization to apply
   **only** `db/hc_owner_stage_expired_activation_recovery.sql` through a
   private privileged, transaction-aware Codespaces database session. Never
   add this migration to web startup or deploy it via Railway/GitHub Actions.
5. Before recovery, re-run privately the read-only preflight for employee 1,
   expiry, unconsumed, no passkey, zero Owners and zero previous recoveries.
   Recheck the matching source/RP ID and HTTP denial controls.
6. Operator runs the script interactively from reviewed source with
   `--reissue-expired-staging-owner`, the **restricted operator**
   `HC_OWNER_OPERATOR_DATABASE_URL` (not `postgres` or runtime DB),
   canonical Timeclock identity/service secret, operator reference,
   existing acknowledgement and new recovery acknowledgement
   `HC_OWNER_OPERATOR_RECOVERY_ACK=I_REVIEWED_EXPIRED_UNUSED_ACTIVATION`.
   Confirm exact employee ID locally. Do not run this operation from chat,
   CI, Railway logs, or public web app.
7. The private 10-minute code is shown **only** in the trusted interactive
   terminal. Do not paste it into chat, commit it, print it in shared logs,
   save it in shell history, or send it to Discord. Use the existing exact
   HTTPS staging hostname with personal phone and current Timeclock PIN;
   register a real hardware-verified passkey. Then separately enroll TOTP.
   Confirm audit/Owner count, sign-out, re-login, replay denial, recovery
   and revocation. Never broaden production permissions as part of this.
8. Staging RP ID `hc-owner-staging-staging.up.railway.app` is separate from
   any future Timcorp public gateway hostname; future production passkey
   setup requires separate reviewed domain migration and user ceremony.

## Critical limitations

- No connector-accessible direct SQL, remote Codespaces terminal or browser
  interaction from this chat. Operator-provided SQL/HTTP evidence is used as
  evidence, not silently re-verified.
- No production Timeclock migration, Employee 13 grant, Owner permission,
  Chrome extension, gateway, DNS, business records, or unrelated services.
- The one-recovery policy means another missed ten-minute window must
  receive a new, separately designed/reviewed recovery decision. Do **not**
  bypass it with raw UPDATE, DELETE, role grants or database reset.
- A `SECURITY DEFINER` function increases sensitivity of the staging
  database: review function ownership, PostgreSQL search path, GRANT/REVOKE,
  role grants, and audit append-only guarantees before any real execution.

## Manager handoff

System: Lightspeed Owner Security / expired first-Owner staging activation.
Implementation: code-only candidate on
`feature/owner-expired-activation-recovery-20261113`.
Testing: HTTP negative probes passed in operator Codespaces, recovery SQL
runtime and physical device acceptance **not yet tested**.
Deployed: no recovery code or migration, existing isolated Owner staging
app remains the current release.
Decision: separately approve reviewed isolated staging SQL after disposable
tests; then operator-only reissue, physical passkey and TOTP acceptance.
