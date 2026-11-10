-- REVIEW CANDIDATE ONLY. NEVER AUTO-RUN FROM A PUBLIC SERVICE.
-- Run out of band ONLY in a newly provisioned, backed-up hc_owner_stage_test DB,
-- after all prerequisite test-only schemas have been independently reviewed.
-- Creates NOLOGIN privilege groups, not connection identities or passwords.
-- Login roles and their passwords must be supplied privately by the operator.

BEGIN;
DO $$
BEGIN
  IF current_database() <> 'hc_owner_stage_test' THEN
    RAISE EXCEPTION 'Refusing grants outside isolated Owner staging database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hc_owner_stage_runtime_privs') THEN
    CREATE ROLE hc_owner_stage_runtime_privs NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hc_owner_stage_operator_privs') THEN
    CREATE ROLE hc_owner_stage_operator_privs NOLOGIN;
  END IF;
END $$;
-- Isolated database: PUBLIC must have no direct access to sensitive tables.
REVOKE ALL ON TABLE
  hc_admin_principals,
  hc_staff_passkeys,
  hc_staff_passkey_challenges,
  hc_staff_passkey_events,
  hc_staff_auth_throttle,
  hc_staff_factor_approvals,
  hc_staff_totp,
  hc_first_owner_activations,
  hc_first_owner_activation_events
FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO hc_owner_stage_runtime_privs, hc_owner_stage_operator_privs;
GRANT SELECT, INSERT ON hc_admin_principals TO hc_owner_stage_runtime_privs;
GRANT SELECT, INSERT, UPDATE ON hc_staff_passkeys TO hc_owner_stage_runtime_privs;
GRANT SELECT, INSERT, UPDATE ON hc_staff_passkey_challenges TO hc_owner_stage_runtime_privs;
GRANT SELECT, INSERT ON hc_staff_passkey_events TO hc_owner_stage_runtime_privs;
GRANT SELECT, INSERT, UPDATE ON hc_staff_auth_throttle TO hc_owner_stage_runtime_privs;
GRANT SELECT, INSERT, UPDATE ON hc_staff_factor_approvals TO hc_owner_stage_runtime_privs;
GRANT SELECT, INSERT, UPDATE ON hc_staff_totp TO hc_owner_stage_runtime_privs;
GRANT SELECT, UPDATE(consumed_at,credential_id)
  ON hc_first_owner_activations TO hc_owner_stage_runtime_privs;
GRANT SELECT, INSERT ON hc_first_owner_activation_events TO hc_owner_stage_runtime_privs;

-- Operator-only issuer: can independently inspect first Owner existence and
-- insert a single pending activation, but cannot edit or delete approvals.
GRANT SELECT ON hc_admin_principals TO hc_owner_stage_operator_privs;
GRANT SELECT, INSERT ON hc_first_owner_activations TO hc_owner_stage_operator_privs;

-- These groups cannot log in. Do not give the app/operator credentials to
-- the other group or grant their login roles CREATEDB, CREATEROLE or SUPERUSER.
-- Operator must create two separate LOGIN roles with distinct private secrets,
-- grant exactly one group to each, and verify role privileges before startup.
COMMIT;
