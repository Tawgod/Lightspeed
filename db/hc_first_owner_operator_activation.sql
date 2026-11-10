-- UNAPPLIED: controlled one-time first Owner bootstrap (alternative to external
-- identity-provider attestation). Explicit operator provisions the EXISTING
-- canonical Timeclock employee ID and a cryptographically random 32-byte
-- activation secret. Only the SHA-256 digest is stored in this table.
-- No application endpoint or service role may INSERT/DELETE or edit approval
-- facts. Runtime role may SELECT and UPDATE ONLY consumed_at / credential_id.
-- Real DB role privileges require separate review before any deployment.
CREATE TABLE IF NOT EXISTS hc_first_owner_activations (
  employee_id bigint PRIMARY KEY CHECK (employee_id>0),
  activation_digest text NOT NULL CHECK (activation_digest ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  issued_by text NOT NULL CHECK (length(issued_by) BETWEEN 8 AND 128),
  consumed_at timestamptz,
  credential_id text,
  CONSTRAINT hc_first_owner_activation_window CHECK (
    expires_at > approved_at AND
    expires_at <= approved_at + interval '15 minutes'
  ),
  CONSTRAINT hc_first_owner_activation_consumption CHECK (
    (consumed_at IS NULL AND credential_id IS NULL)
    OR (consumed_at IS NOT NULL AND credential_id IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS hc_first_owner_activation_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id bigint NOT NULL CHECK (employee_id>0),
  credential_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type='first_owner_passkey_activated'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION hc_first_owner_activation_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'First Owner activation events are append-only';
END; $$;
DROP TRIGGER IF EXISTS hc_first_owner_activation_events_immutable
  ON hc_first_owner_activation_events;
CREATE TRIGGER hc_first_owner_activation_events_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON hc_first_owner_activation_events
  FOR EACH STATEMENT EXECUTE FUNCTION hc_first_owner_activation_events_immutable();
-- After first successful activation, the app MUST disable the bootstrap route
-- and revoke the activator secret. Never reuse a PIN or existing session token.
