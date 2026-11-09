-- UNAPPLIED: First REAL Owner commissioning. Never run in synthetic staging.
-- Authorized records are inserted only by a separately trusted offline operator
-- after independent business ownership and Timeclock-identity verification.
-- No browser route, PIN endpoint, Discord role or ordinary admin principal may
-- write this table. Database permissions MUST reserve INSERT to operator role.
CREATE TABLE IF NOT EXISTS hc_owner_commissioning_authorizations (
  approval_id uuid PRIMARY KEY,
  employee_id bigint NOT NULL CHECK (employee_id > 0),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  independent_operator_ref text NOT NULL CHECK (length(independent_operator_ref) BETWEEN 8 AND 128),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  registered_credential_id text,
  CONSTRAINT hc_first_owner_valid_window CHECK (expires_at > approved_at AND expires_at <= approved_at + interval '30 minutes'),
  CONSTRAINT hc_first_owner_consumption_pair CHECK ((consumed_at IS NULL AND registered_credential_id IS NULL) OR (consumed_at IS NOT NULL AND registered_credential_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS hc_owner_single_pending_commissioning
  ON hc_owner_commissioning_authorizations (employee_id)
  WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS hc_owner_commissioning_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL REFERENCES hc_owner_commissioning_authorizations(approval_id),
  employee_id bigint NOT NULL CHECK(employee_id>0),
  credential_id text NOT NULL,
  evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (event_type='first_owner_passkey_committed'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION hc_owner_commissioning_history_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Owner commissioning audit is append-only'; END; $$;
DROP TRIGGER IF EXISTS hc_owner_commissioning_events_immutable ON hc_owner_commissioning_events;
CREATE TRIGGER hc_owner_commissioning_events_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON hc_owner_commissioning_events
 FOR EACH STATEMENT EXECUTE FUNCTION hc_owner_commissioning_history_immutable();

-- Live deployment MUST additionally establish DB role privileges: the app
-- role may SELECT/UPDATE authorizations only for consumption but NEVER INSERT
-- or DELETE approvals; the offline authorization operator alone may INSERT.
-- No GRANT statements here; database users/role names must be approved first.
