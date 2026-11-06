-- Unapplied admin authorization storage. Employee ids are Timeclock ids.
-- The first OWNER must be linked by a separately audited, independently
-- verified commissioning ceremony; NEVER auto-promote employee 901, a PIN,
-- Discord role, Lightspeed role or the first person who opens the page.
CREATE TABLE IF NOT EXISTS hc_admin_principals (
 employee_id bigint PRIMARY KEY CHECK (employee_id > 0),
 role text NOT NULL CHECK (role IN ('owner','delegated_admin')),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
 appointed_by bigint NULL,
 appointed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hc_admin_single_active_owner
 ON hc_admin_principals ((role)) WHERE role='owner' AND active=true;

CREATE TABLE IF NOT EXISTS hc_admin_grants (
 employee_id bigint NOT NULL REFERENCES hc_admin_principals(employee_id),
 operation text NOT NULL CHECK(length(operation) BETWEEN 3 AND 100),
 granted_by bigint NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(employee_id,operation)
);
-- The owner may permit a manager to grant only a selected set of tool actions.
-- This is NOT the manager's own permission to use the tool.
CREATE TABLE IF NOT EXISTS hc_admin_grant_scopes (
 employee_id bigint NOT NULL REFERENCES hc_admin_principals(employee_id),
 tool_operation text NOT NULL CHECK(length(tool_operation) BETWEEN 3 AND 100),
 granted_by bigint NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(employee_id,tool_operation)
);
-- Optional per-setting delegation. Even when a manager can edit tool
-- settings, each actual tool-setting ID must be explicitly approved by Owner.
CREATE TABLE IF NOT EXISTS hc_admin_setting_scopes (
 employee_id bigint NOT NULL REFERENCES hc_admin_principals(employee_id),
 setting_id text NOT NULL CHECK(length(setting_id) BETWEEN 3 AND 100),
 granted_by bigint NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(employee_id,setting_id)
);
-- Per-employee tool grants consumed later by the exact operation gateway.
CREATE TABLE IF NOT EXISTS hc_employee_tool_grants (
 employee_id bigint NOT NULL CHECK(employee_id > 0),
 operation text NOT NULL CHECK(length(operation) BETWEEN 3 AND 100),
 granted_by bigint NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(employee_id,operation)
);
CREATE TABLE IF NOT EXISTS hc_admin_authorization_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id bigint NOT NULL CHECK(actor_id>0),
 target_employee_id bigint NOT NULL CHECK(target_employee_id>0),
 kind text NOT NULL CHECK(kind IN ('admin_grant','admin_revoke','admin_disable','tool_grant','tool_revoke','scope_grant','scope_revoke','setting_scope_grant','setting_scope_revoke')),
 operation text NOT NULL CHECK(length(operation) BETWEEN 3 AND 100),
 reason text NOT NULL CHECK(length(reason) BETWEEN 8 AND 400),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION hc_admin_auth_event_append_only()
 RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Admin authorization history is append-only'; END;
 $$;
DROP TRIGGER IF EXISTS hc_admin_auth_events_immutable ON hc_admin_authorization_events;
CREATE TRIGGER hc_admin_auth_events_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON hc_admin_authorization_events
 FOR EACH STATEMENT EXECUTE FUNCTION hc_admin_auth_event_append_only();
