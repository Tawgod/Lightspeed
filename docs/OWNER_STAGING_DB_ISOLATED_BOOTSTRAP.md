**Date:** 2026-11-12. **Status:** Database schema + NOLOGIN privilege groups deployed/tested in isolated staging; Owner login not deployed, no real login credentials or production data.

## Verified completion — 2026-11-12

- Owner-approved staging DB-only deployment: new PostgreSQL 18 `Postgres-x8Ui` service `5c4498e4-cffb-4224-916a-af57391d1cd9`, volume `04530c8a-cf70-4857-9f9b-0828b47bc54c`, Railway deployment **`51d04bf4-0f3e-4716-ba17-8e756a1bc1be` SUCCESS**. No public service domain or public TCP proxy. Running inside the already isolated `HC PR63 Isolated Staging / staging`, **separate Postgres instance** from foundation DB service `257803e5-7352-4113-a4be-f4f6edaddd22`.
- One-time migration runner `hc-owner-db-bootstrap` source pinned to **`Tawgod/Lightspeed:feature/owner-db-isolated-bootstrap-20261112@81d23862428ceb3e35dafa32f575e7ab9135e2b5`**, connected only to the new Postgres via private Railway `Postgres-x8Ui.DATABASE_URL` reference, and explicitly denied production project/env/other service, wrong database name or non-PG18. Focused CI [43297855881](https://github.com/Tawgod/Lightspeed/actions/runs/43297855881) **SUCCESS**.
- One-time SQL bootstrap deployment **`bf0cde18-9384-4d20-8ffe-577dcdea4bb2` SUCCESS**, exactly `HC_OWNER_DB_BOOTSTRAP_OK tables=9 nonlogin_groups=2 owner_activations=0` logged after transaction committed and the runtime/operator roles' deny/allow permissions were verified.
- The ephemeral `hc-owner-db-bootstrap` service (`6d29f944-e322-44c6-ac72-74904b3153cc`) was **deleted after verifying logs/commit**, removing its privileged root `DATABASE_URL` reference. Only the new database/volume and existing foundation app/DB remain in the project; no pending patch. Running `hc-foundation-pr63` stayed on deployment `4cae33bf-1569-4b2d-90a0-2aee9e5de55e` at `34d92a0`, separate database.
- Original `HC Owner Security Staging/test` Railway project patch **`45d1db2e-1f10-4b27-94e0-c0970c5d2d28`** remains **STAGED (55 changes)**, uncommitted, containing old unconfigured app + another Postgres. **Do not accept this patch**; choose reviewed Owner app deployment into the current isolated staging project (same private network as new Owner DB) or explicitly reconcile/remove stale staged resources later, with owner approval. Do not create duplicate live Owner DB instances.
- **Not yet done:** separate runtime/operator **LOGIN** roles and private passwords, verified public app read-only privilege preflight as a LOGIN identity, staging Owner app deployment/HTTPS RP ID, Timeclock dedicated prod login-throttle schema and secret activation, exact real active employee ID, passkey, Authenticator. No production change or actual Owner appointment.

**Data boundary:** This is a fresh database containing only empty staging Owner tables, no customer records, employee PINs or credential secrets. Future LOGIN passwords must be generated/stored through a user-controlled private secret channel, not GitHub/chat/CI. NOLOGIN privilege groups cannot authenticate to the DB by themselves; do not mistake them for completed Owner app credentials.

---
t / DB-only preparation; no Owner login or production data.

## Why this is separate

The original `HC Owner Security Staging/test` Railway project still contains 55 staged changes including an unconfigured Owner app. Railway's available `accept_deploy` commits **all** staged changes; applying it just to create Postgres would also start a fail-closed, unready app. Preserve that original patch.

A second **independent PostgreSQL 18 instance** was therefore provisioned inside the already isolated `HC PR63 Isolated Staging/staging` Railway project, with its own volume and credentials. Its temporary provisioner will connect exclusively over Railway's private network, create `hc_owner_stage_test`, apply the exact seven audited staging SQL files, create **NOLOGIN** runtime/operator privilege groups, and verify that the runtime cannot issue or rewrite activation grants. No Owner, employee record, passkey, activation, SMTP, production database or service credential is created or copied.

## Platform scope (hardcoded to prevent cross-environment execution)
- Project: `5b46096d-3178-47ec-ba88-d5037696346a` — `HC PR63 Isolated Staging`
- Environment: `46b93c76-3085-4e76-a37d-90dfdd250dd2` — `staging`
- **New separate** Postgres 18 service: `5c4498e4-cffb-4224-916a-af57391d1cd9` — `Postgres-x8Ui`, volume `04530c8a-cf70-4857-9f9b-0828b47bc54c`
- Provisioning runner: ephemeral `hc-owner-db-bootstrap` service, no public domain; private `HC_OWNER_BOOTSTRAP_DATABASE_URL=${{Postgres-x8Ui.DATABASE_URL}}` reference only. Remove runner after read-back, so no long-lived staging app contains the privileged database URL.

## SQL scope
`hc_owner_stage_test` only, no existing business data. Exactly:
`db/hc_admin_delegations.sql`, `db/hc_staff_passkeys.sql`, `db/hc_staff_auth_throttle.sql`, `db/hc_staff_factor_approvals.sql`, `db/hc_staff_totp.sql`, `db/hc_first_owner_operator_activation.sql`, and `db/hc_owner_staging_privilege_groups.sql`.

Two NOLOGIN groups: `hc_owner_stage_runtime_privs` (can SELECT first activation and UPDATE only consumed_at/credential_id) and `hc_owner_stage_operator_privs` (can INSERT first activation, cannot read TOTP or consume it). DB PUBLIC CONNECT and public schema CREATE revoked. No LOGIN role/password created yet; those require protected secret custody and exact app setup and are **not** silently inferred from these groups.

## Acceptance
- Test fail-closed scope checks (cannot target production project, wrong Postgres hostname, default client public token, wrong service or dangerous auth flags).
- Railway private migration runner prints only `HC_OWNER_DB_BOOTSTRAP_OK tables=9 nonlogin_groups=2 owner_activations=0` after applying every SQL file in a transaction and independently verifying all privileges.
- App service `hc-foundation-pr63` remains pinned to its existing commit, using the **other Postgres instance**. Production services, dedicated Owner web project patch, Timeclock PIN, central Timcorp gateway and all current grants unchanged.

## Next gate
Generate **independent** Owner runtime/operator LOGIN credentials via an operator-controlled private channel; assign exactly one group per role, verify `ownerStagingDatabasePreflight` under the runtime login, then set independent HTTPS WebAuthn RP ID and prepare the actual app. Production Timeclock rate-limit SQL/identity activation are **separate** future approvals. Do not register actual Owner or issue one-time activation token during DB provision.
