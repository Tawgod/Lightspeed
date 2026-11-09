-- Candidate-only onboarding request workflow, never alters Timeclock/Lightspeed.
-- Minimal identity intake; no birth dates, email, home address or payroll data.
CREATE TABLE IF NOT EXISTS hc_admin_onboarding_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_key uuid NOT NULL UNIQUE,
 requested_by bigint NOT NULL CHECK (requested_by>0),
 employee_name text NOT NULL CHECK (length(employee_name) BETWEEN 2 AND 120),
 requested_role text NOT NULL CHECK (requested_role IN ('staff','manager')),
 reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 400),
 status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','cancelled','completed','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT hc_onboarding_request_identity UNIQUE (requested_by,request_key)
);
CREATE INDEX IF NOT EXISTS hc_admin_onboarding_requests_actor
 ON hc_admin_onboarding_requests (requested_by,created_at DESC);
CREATE TABLE IF NOT EXISTS hc_admin_onboarding_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL REFERENCES hc_admin_onboarding_requests(id),
 actor_employee_id bigint NOT NULL CHECK(actor_employee_id>0),
 action text NOT NULL CHECK(action IN ('requested','cancelled','approved','rejected')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 8 AND 400),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION hc_admin_onboarding_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Onboarding events are append-only'; END;
$$;
DROP TRIGGER IF EXISTS hc_admin_onboarding_immutable ON hc_admin_onboarding_events;
CREATE TRIGGER hc_admin_onboarding_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON hc_admin_onboarding_events FOR EACH STATEMENT
 EXECUTE FUNCTION hc_admin_onboarding_events_immutable();
