-- Candidate only. Never apply to a live Railway database without backup
-- and explicit migration approval. No passwords, PINs or private keys.
CREATE TABLE IF NOT EXISTS hc_staff_passkeys (
  credential_id TEXT PRIMARY KEY CHECK (length(credential_id) BETWEEN 10 AND 1024),
  employee_id BIGINT NOT NULL CHECK(employee_id>0),
  public_key BYTEA NOT NULL CHECK(octet_length(public_key) BETWEEN 24 AND 2048),
  counter BIGINT NOT NULL DEFAULT 0 CHECK(counter>=0),
  transports TEXT[] NOT NULL DEFAULT '{}',
  device_type TEXT NOT NULL DEFAULT 'unknown',
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  generation UUID NOT NULL DEFAULT gen_random_uuid(),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hc_staff_passkeys_employee ON hc_staff_passkeys(employee_id)
 WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS hc_staff_passkey_challenges (
  challenge_id UUID PRIMARY KEY,
  employee_id BIGINT NOT NULL CHECK(employee_id>0),
  session_hash CHAR(64) NOT NULL CHECK(session_hash ~ '^[0-9a-f]{64}$'),
  purpose TEXT NOT NULL CHECK(purpose IN ('register','authenticate')),
  challenge TEXT NOT NULL CHECK(length(challenge) BETWEEN 32 AND 512),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hc_staff_passkey_challenges_expiry ON hc_staff_passkey_challenges(expires_at);
CREATE TABLE IF NOT EXISTS hc_staff_passkey_events (
  event_id UUID PRIMARY KEY,
  credential_id TEXT NOT NULL,
  employee_id BIGINT NOT NULL CHECK(employee_id>0),
  approver_id BIGINT CHECK(approver_id>0),
  kind TEXT NOT NULL CHECK(kind IN ('registered','revoked')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION hc_passkey_audit_append_only()
 RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Staff passkey audit is append-only';
END;
$$;
DROP TRIGGER IF EXISTS hc_passkey_event_no_update_delete ON hc_staff_passkey_events;
CREATE TRIGGER hc_passkey_event_no_update_delete BEFORE UPDATE OR DELETE ON hc_staff_passkey_events
 FOR EACH ROW EXECUTE FUNCTION hc_passkey_audit_append_only();
DROP TRIGGER IF EXISTS hc_passkey_event_no_truncate ON hc_staff_passkey_events;
CREATE TRIGGER hc_passkey_event_no_truncate BEFORE TRUNCATE ON hc_staff_passkey_events
 FOR EACH STATEMENT EXECUTE FUNCTION hc_passkey_audit_append_only();
