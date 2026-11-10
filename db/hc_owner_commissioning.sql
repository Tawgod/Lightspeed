-- UNAPPLIED: First REAL Owner commissioning. Never run on synthetic staging.
-- Approval rows may ONLY be inserted by separately authorized offline operator.
-- The runtime role may read and consume an approval, but may NOT mint, delete
-- or directly change signed approval facts. Reviewed GRANT/REVOKE statements
-- must be applied separately for actual production role names.
CREATE TABLE IF NOT EXISTS hc_owner_commissioning_authorizations (
  approval_id uuid PRIMARY KEY,
  employee_id bigint NOT NULL CHECK (employee_id > 0),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_signature text NOT NULL CHECK (evidence_signature ~ '^[A-Za-z0-9_-]{86}$'),
  independent_operator_ref text NOT NULL CHECK (
    length(independent_operator_ref) BETWEEN 8 AND 128
    AND independent_operator_ref ~ '^[A-Za-z0-9_.:@-]+$'
  ),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  registered_credential_id text,
  CONSTRAINT hc_first_owner_valid_window CHECK (
    expires_at > approved_at
    AND expires_at <= approved_at + interval '30 minutes'
  ),
  CONSTRAINT hc_first_owner_consumption_pair CHECK (
    (consumed_at IS NULL AND registered_credential_id IS NULL)
    OR (consumed_at IS NOT NULL AND registered_credential_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS hc_owner_single_pending_commissioning
  ON hc_owner_commissioning_authorizations (employee_id)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS hc_owner_commissioning_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL REFERENCES hc_owner_commissioning_authorizations(approval_id),
  employee_id bigint NOT NULL CHECK (employee_id > 0),
  credential_id text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (event_type = 'first_owner_passkey_committed'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION hc_owner_commissioning_history_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Owner commissioning audit is append-only';
END; $$;

DROP TRIGGER IF EXISTS hc_owner_commissioning_events_immutable
  ON hc_owner_commissioning_events;
CREATE TRIGGER hc_owner_commissioning_events_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON hc_owner_commissioning_events
  FOR EACH STATEMENT EXECUTE FUNCTION hc_owner_commissioning_history_immutable();

-- The app must not be granted the offline operator's private Ed25519 key,
-- permission to INSERT a commissioning approval, or permission to edit the
-- employee_id / signature / evidence digest / validity on existing approval.
-- Runtime consumption must be limited to consumed_at and registered_credential_id.
-- Secure, independently audited issuer and key custody remain unimplemented.
