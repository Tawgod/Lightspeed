-- DEVELOPMENT ONLY: do not apply to production without migration, security
-- and backup authorization. Device PRIVATE keys never enter the database.
CREATE TABLE IF NOT EXISTS hc_staff_stations (
 device_id UUID PRIMARY KEY,
 public_key_spki BYTEA NOT NULL UNIQUE CHECK (octet_length(public_key_spki)=44),
 label VARCHAR(80) NOT NULL CHECK (length(label)>0),
 generation UUID NOT NULL DEFAULT gen_random_uuid(),
 registered_by BIGINT NOT NULL CHECK (registered_by>0),
 registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS hc_staff_station_challenges (
 challenge_id UUID PRIMARY KEY,
 device_id UUID NOT NULL REFERENCES hc_staff_stations(device_id),
 employee_id BIGINT NOT NULL CHECK(employee_id>0),
 session_hash VARCHAR(64) NOT NULL CHECK(session_hash ~ '^[A-Za-z0-9_-]{43}$'),
 challenge BYTEA NOT NULL CHECK(octet_length(challenge)=32),
 state TEXT NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','consumed')),
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hc_staff_station_challenge_expiry
 ON hc_staff_station_challenges(expires_at);
CREATE TABLE IF NOT EXISTS hc_staff_station_events (
 event_id UUID PRIMARY KEY,
 device_id UUID NOT NULL REFERENCES hc_staff_stations(device_id),
 actor_id BIGINT NOT NULL CHECK(actor_id>0),
 kind TEXT NOT NULL CHECK(kind IN ('registered','revoked')),
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION hc_station_audit_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Station audit is append-only';
END;
$$;
DROP TRIGGER IF EXISTS hc_station_event_no_update_delete ON hc_staff_station_events;
CREATE TRIGGER hc_station_event_no_update_delete BEFORE UPDATE OR DELETE
 ON hc_staff_station_events FOR EACH ROW EXECUTE FUNCTION hc_station_audit_append_only();
DROP TRIGGER IF EXISTS hc_station_event_no_truncate ON hc_staff_station_events;
CREATE TRIGGER hc_station_event_no_truncate BEFORE TRUNCATE
 ON hc_staff_station_events FOR EACH STATEMENT EXECUTE FUNCTION hc_station_audit_append_only();
-- Expired challenges require a reviewed maintenance/retention job.