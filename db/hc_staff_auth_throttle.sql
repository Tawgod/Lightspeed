-- Proposed cross-tool staff login throttle store; NOT applied to production.
-- SQL remains separate from the shared Lightspeed mutation schema.
-- Store only HMAC-hashed account/source identifiers; no PIN/IP/usernames/tokens.
CREATE TABLE IF NOT EXISTS hc_staff_auth_throttle (
  key_hash CHAR(64) PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  balance DOUBLE PRECISION NOT NULL CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hc_staff_auth_throttle_cleanup_idx
  ON hc_staff_auth_throttle (updated_at);
-- A future authorized maintenance job may delete rows unused for 30+ days;
-- never automatically relax a current employee/source login block.
