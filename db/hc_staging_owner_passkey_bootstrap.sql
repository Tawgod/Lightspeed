-- SYNTHETIC STAGING ONLY. An independent Railway-provisioned secret is
-- also required by the application; no secret value is stored in PostgreSQL.
-- One signed test employee session + one valid bootstrap key + real verified
-- WebAuthn credential is needed to consume this grant.
CREATE TABLE IF NOT EXISTS hc_staging_owner_passkey_bootstrap (
 id INTEGER PRIMARY KEY CHECK (id=1),
 started_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ,
 consumed_at TIMESTAMPTZ,
 credential_id TEXT,
 CHECK ((started_at IS NULL AND expires_at IS NULL AND consumed_at IS NULL AND credential_id IS NULL) OR
        (started_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at>started_at AND
         ((consumed_at IS NULL AND credential_id IS NULL) OR
          (consumed_at IS NOT NULL AND consumed_at>=started_at AND credential_id IS NOT NULL))))
);
-- No expiry starts when the service deploys. A trusted signed test session
-- AND independent owner bootstrap key must initiate the single-use window.
INSERT INTO hc_staging_owner_passkey_bootstrap(id)
 VALUES(1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS hc_staging_owner_passkey_bootstrap_events(
 event_id UUID PRIMARY KEY,
 employee_id BIGINT NOT NULL CHECK (employee_id=901),
 credential_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('started','completed')),
 CHECK ((kind='started' AND credential_id IS NULL) OR
        (kind='completed' AND credential_id IS NOT NULL)),
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION hc_staging_owner_bootstrap_audit_immutable()
 RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Staging Owner bootstrap audit is append-only';
END;
$$;
DROP TRIGGER IF EXISTS hc_staging_owner_bootstrap_audit_no_change
 ON hc_staging_owner_passkey_bootstrap_events;
CREATE TRIGGER hc_staging_owner_bootstrap_audit_no_change
 BEFORE UPDATE OR DELETE OR TRUNCATE
 ON hc_staging_owner_passkey_bootstrap_events
 FOR EACH STATEMENT EXECUTE FUNCTION hc_staging_owner_bootstrap_audit_immutable();
