-- Development candidate ONLY. Do not apply in production without approved
-- database backup, key custody, authorization policy, and integration testing.
-- One TOTP enrollment per verified Timeclock employee ID. Secrets are encrypted
-- by the application using AES-256-GCM with a distinct server-only 32-byte key.
CREATE TABLE IF NOT EXISTS hc_staff_totp (
  employee_id BIGINT PRIMARY KEY CHECK (employee_id > 0),
  secret_ciphertext BYTEA NOT NULL,
  factor_generation UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  pending_expires_at TIMESTAMPTZ,
  enrollment_failures SMALLINT NOT NULL DEFAULT 0
    CHECK (enrollment_failures BETWEEN 0 AND 5),
  last_used_step BIGINT NOT NULL DEFAULT -1 CHECK (last_used_step >= -1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hc_staff_totp_state_check CHECK (
    (status = 'pending' AND pending_expires_at IS NOT NULL)
    OR (status IN ('active','revoked') AND pending_expires_at IS NULL)
  )
);
-- Factor resets/recovery are deliberately not provided by the login API.
-- A future manager-approved reset must be separately authenticated/audited.

-- Auditable factor revocation is a separate manager-only write. Do not expose
-- this table or a reset operation through the employee self-service router.
CREATE TABLE IF NOT EXISTS hc_staff_factor_recovery_events (
  event_id UUID PRIMARY KEY,
  employee_id BIGINT NOT NULL CHECK (employee_id > 0),
  approver_id BIGINT NOT NULL CHECK (approver_id > 0),
  reason TEXT NOT NULL CHECK (reason IN ('lost_device','suspected_compromise','employee_departed')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION hc_staff_recovery_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Staff factor recovery audit is append-only';
END;
$$;
DROP TRIGGER IF EXISTS hc_staff_recovery_no_update_delete ON hc_staff_factor_recovery_events;
CREATE TRIGGER hc_staff_recovery_no_update_delete
BEFORE UPDATE OR DELETE ON hc_staff_factor_recovery_events
FOR EACH ROW EXECUTE FUNCTION hc_staff_recovery_append_only();
DROP TRIGGER IF EXISTS hc_staff_recovery_no_truncate ON hc_staff_factor_recovery_events;
CREATE TRIGGER hc_staff_recovery_no_truncate
BEFORE TRUNCATE ON hc_staff_factor_recovery_events
FOR EACH STATEMENT EXECUTE FUNCTION hc_staff_recovery_append_only();
