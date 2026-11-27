-- Additive candidate only. Apply as approved schema owner, never at application startup.
BEGIN;
CREATE SCHEMA hc_security_identity;
REVOKE ALL ON SCHEMA hc_security_identity FROM PUBLIC;
CREATE TABLE hc_security_identity.limits (
  scope_key text PRIMARY KEY CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  count integer NOT NULL CHECK (count BETWEEN 1 AND 121),
  window_start timestamptz NOT NULL
);
REVOKE ALL ON TABLE hc_security_identity.limits FROM PUBLIC;
COMMIT;
-- No runtime grants until exact role/ownership/privilege review. No legacy table changes.
