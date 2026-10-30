-- Development candidate ONLY. Do not apply in production without approved
-- database backup, key custody, authorization policy, and integration testing.
-- One TOTP enrollment per verified Timeclock employee ID. Secrets are encrypted
-- by the application using AES-256-GCM with a distinct server-only 32-byte key.
CREATE TABLE IF NOT EXISTS hc_staff_totp (
  employee_id BIGINT PRIMARY KEY CHECK (employee_id > 0),
  secret_ciphertext BYTEA NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active')),
  pending_expires_at TIMESTAMPTZ,
  enrollment_failures SMALLINT NOT NULL DEFAULT 0
    CHECK (enrollment_failures BETWEEN 0 AND 5),
  last_used_step BIGINT NOT NULL DEFAULT -1 CHECK (last_used_step >= -1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hc_staff_totp_state_check CHECK (
    (status = 'pending' AND pending_expires_at IS NOT NULL)
    OR (status = 'active' AND pending_expires_at IS NULL)
  )
);
-- Factor resets/recovery are deliberately not provided by the login API.
-- A future manager-approved reset must be separately authenticated/audited.
