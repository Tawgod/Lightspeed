-- Additive, unapplied production Timeclock schema for isolated Owner-stage auth.
-- Apply ONLY with separate production database migration approval.
-- No raw PINs, source addresses, tokens, or employee names stored.
CREATE TABLE IF NOT EXISTS hc_owner_stage_login_limits (
  scope_key char(64) PRIMARY KEY CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  count integer NOT NULL CHECK (count BETWEEN 0 AND 2147483647),
  window_start timestamptz NOT NULL
);
-- Separate per-account counters are shared by all Railway instances.
-- The router fails closed if this table/DB is unavailable.
-- Backup and expiry strategy must be approved before rollout.
