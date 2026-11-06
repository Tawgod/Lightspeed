-- ADDITIVE CANDIDATE ONLY: DO NOT APPLY TO PRODUCTION BY THIS COMMIT.
-- Admin policy persistence does not change existing signed session issuance
-- until separately reviewed gateway wiring, Timeclock migration and rollout.
CREATE TABLE IF NOT EXISTS hc_admin_session_policies (
  policy_id smallint PRIMARY KEY DEFAULT 1 CHECK (policy_id = 1),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  local_idle_seconds integer NOT NULL DEFAULT 900 CHECK (local_idle_seconds BETWEEN 300 AND 7200),
  local_absolute_seconds integer NOT NULL DEFAULT 900 CHECK (local_absolute_seconds BETWEEN 900 AND 43200),
  remote_idle_seconds integer NOT NULL DEFAULT 900 CHECK (remote_idle_seconds BETWEEN 300 AND 3600),
  remote_absolute_seconds integer NOT NULL DEFAULT 900 CHECK (remote_absolute_seconds BETWEEN 900 AND 7200),
  changed_by bigint NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hc_admin_policy_local_order CHECK (local_idle_seconds <= local_absolute_seconds),
  CONSTRAINT hc_admin_policy_remote_order CHECK (remote_idle_seconds <= remote_absolute_seconds)
);
INSERT INTO hc_admin_session_policies (policy_id) VALUES(1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS hc_admin_session_policy_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_version bigint NOT NULL,
  new_version bigint NOT NULL,
  employee_id bigint NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 8 AND 400),
  previous_policy jsonb NOT NULL,
  next_policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hc_admin_session_policy_versions CHECK(new_version = old_version + 1),
  CONSTRAINT hc_admin_session_policy_event_employee CHECK(employee_id > 0)
);
CREATE OR REPLACE FUNCTION hc_admin_session_policy_audit_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Admin policy history is append-only';
END;
$$;
DROP TRIGGER IF EXISTS hc_admin_session_policy_audit_immutable ON hc_admin_session_policy_events;
CREATE TRIGGER hc_admin_session_policy_audit_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON hc_admin_session_policy_events
  FOR EACH STATEMENT EXECUTE FUNCTION hc_admin_session_policy_audit_append_only();
