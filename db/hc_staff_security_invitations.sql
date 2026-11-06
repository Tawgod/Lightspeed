-- DEVELOPMENT ONLY — never migrate a production database without approval.
-- Invitation authorizes requesting approval, NOT authenticator seed generation.
CREATE TABLE IF NOT EXISTS hc_staff_security_invitations (
 invitation_id UUID PRIMARY KEY,
 token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 employee_id BIGINT NOT NULL CHECK(employee_id>0),
 invited_by_employee_id BIGINT NOT NULL CHECK(invited_by_employee_id>0),
 actor_discord_id TEXT NOT NULL CHECK(actor_discord_id ~ '^[0-9]{15,22}$'),
 target_discord_id TEXT NOT NULL CHECK(target_discord_id ~ '^[0-9]{15,22}$'),
 guild_id TEXT NOT NULL CHECK(guild_id ~ '^[0-9]{15,22}$'),
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 enrollment_request_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((consumed_at IS NULL AND enrollment_request_id IS NULL) OR
        (consumed_at IS NOT NULL AND enrollment_request_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS hc_staff_security_invites_target
 ON hc_staff_security_invitations(employee_id,expires_at);
CREATE TABLE IF NOT EXISTS hc_staff_security_invitation_events (
 event_id UUID PRIMARY KEY,
 invitation_id UUID NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('issued','redeemed')),
 actor_employee_id BIGINT NOT NULL CHECK(actor_employee_id>0),
 at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION hc_staff_invitation_audit_immutable()
 RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Staff enrollment invitation audit is append-only';
END;
$$;
DROP TRIGGER IF EXISTS hc_staff_invite_event_no_mutation ON hc_staff_security_invitation_events;
CREATE TRIGGER hc_staff_invite_event_no_mutation BEFORE UPDATE OR DELETE ON hc_staff_security_invitation_events
 FOR EACH ROW EXECUTE FUNCTION hc_staff_invitation_audit_immutable();
