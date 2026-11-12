# One-time Owner database provisioning — isolated staging

**Date:** 2026-11-12. **Status:** In Development / DB-only preparation; no Owner login or production data.

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
