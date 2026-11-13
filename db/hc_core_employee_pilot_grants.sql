-- ISOLATED DEVELOPMENT PILOT ONLY. NEVER APPLY TO A LIVE HOBBY CORNER DB.
-- Explicit operator provisioning and separate read-only runtime credentials.
-- There is no employee-facing grant API, no Owner role inference, and no write scope.
CREATE TABLE IF NOT EXISTS public.hc_core_employee_pilot_grants (
  employee_id BIGINT NOT NULL CHECK (employee_id = 901),
  operation TEXT NOT NULL CHECK (operation = 'special-orders.read'),
  approved_by BIGINT NOT NULL CHECK (approved_by > 0 AND approved_by <> employee_id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (employee_id, operation),
  CONSTRAINT hc_core_employee_pilot_grant_window CHECK (
    expires_at > granted_at AND expires_at <= granted_at + interval '24 hours'
  )
);
-- Do NOT grant INSERT/UPDATE/DELETE/TRUNCATE/CREATE to the runtime.
-- Provision a separate SELECT-only login role through an independently
-- approved operator process. No role names, passwords or test grants here.
