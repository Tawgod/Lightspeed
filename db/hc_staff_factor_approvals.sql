-- DEVELOPMENT ONLY. Requires separately approved migration and backup.
-- Approval requests are scoped to an already VERIFIED employee session's
-- backend-derived opaque binding (stored only as a keyed HMAC).
CREATE TABLE IF NOT EXISTS hc_staff_factor_approvals (
  request_id UUID PRIMARY KEY,
  employee_id BIGINT NOT NULL CHECK (employee_id > 0),
  session_hash CHAR(64) NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('requested','approved','started','finished','denied','expired')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  approver_id BIGINT CHECK (approver_id > 0),
  approver_method TEXT CHECK (approver_method IN ('passkey','security-key','oidc-mfa')),
  approved_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CHECK ((state NOT IN ('approved','started','finished')) OR
         (approver_id IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((state NOT IN ('started','finished')) OR started_at IS NOT NULL),
  CHECK ((state <> 'finished') OR finished_at IS NOT NULL)
);
-- Prevent simultaneous live enrollment requests for the same employee,
-- including concurrent requests across multiple Railway replicas.
CREATE UNIQUE INDEX IF NOT EXISTS hc_staff_factor_one_pending_employee
  ON hc_staff_factor_approvals(employee_id)
  WHERE state IN ('requested','approved','started');
CREATE INDEX IF NOT EXISTS hc_staff_factor_approvals_expiry
  ON hc_staff_factor_approvals(expires_at);
-- Keep approval history for manager audit; implement retention policies
-- separately, with production sign-off. No PINs, TOTP seeds, or raw
-- bearer session tokens are stored in this table.
