-- Hobby Corner shared Lightspeed gateway persistence.
-- REVIEWED MIGRATION CANDIDATE: Do not apply to live Railway without explicit deployment approval.
-- Idempotent, additive schema only. Never drops, truncates, or modifies existing tables.
-- Keys are tenant/environment/operation-scoped by the caller (scope). No automatic key expiry.
CREATE TABLE IF NOT EXISTS hc_lightspeed_idempotency (
  scope TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  fingerprint CHAR(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  lease UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified','unknown')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  PRIMARY KEY (scope, operation_key),
  CONSTRAINT hc_lightspeed_idempotency_verified_check
    CHECK (state <> 'verified' OR (verified_at IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS hc_lightspeed_idempotency_unknown_idx
  ON hc_lightspeed_idempotency (updated_at) WHERE state IN ('pending','unknown');

CREATE TABLE IF NOT EXISTS hc_lightspeed_audit (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage TEXT NOT NULL CHECK (stage IN ('requested','verified','rejected','unknown')),
  correlation_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('employee','service')),
  actor_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  fingerprint TEXT NOT NULL,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS hc_lightspeed_audit_correlation_idx
  ON hc_lightspeed_audit (correlation_id, event_id);

-- Database-level append-only guard against accidental edits by the application.
CREATE OR REPLACE FUNCTION hc_lightspeed_audit_block_changes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Lightspeed audit history is append-only';
END;
$$;
DROP TRIGGER IF EXISTS hc_lightspeed_audit_immutable ON hc_lightspeed_audit;
CREATE TRIGGER hc_lightspeed_audit_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON hc_lightspeed_audit
FOR EACH STATEMENT EXECUTE FUNCTION hc_lightspeed_audit_block_changes();
