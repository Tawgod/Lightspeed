-- Additive candidate, apply only after explicit migration approval.
-- Execute as dedicated schema owner, not application role. No seed identities.
BEGIN;
CREATE SCHEMA hc_security_operational;
REVOKE ALL ON SCHEMA hc_security_operational FROM PUBLIC;
CREATE TABLE hc_security_operational.authority(singleton boolean PRIMARY KEY CHECK(singleton),policy_revision integer NOT NULL CHECK(policy_revision>0),evidence_revision integer NOT NULL CHECK(evidence_revision>0));
INSERT INTO hc_security_operational.authority VALUES(true,1,1);
CREATE TABLE hc_security_operational.employee(id text PRIMARY KEY CHECK(id ~ '^[1-9][0-9]{0,15}$'),active boolean NOT NULL,policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'));
CREATE TABLE hc_security_operational.session(id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{32}$'),employee_id text NOT NULL REFERENCES hc_security_operational.employee(id),policy_revision integer NOT NULL CHECK(policy_revision>0),evidence_revision integer NOT NULL CHECK(evidence_revision>0),expires_at bigint NOT NULL,revoked boolean NOT NULL DEFAULT false);
CREATE TABLE hc_security_operational.audit(id uuid PRIMARY KEY,actor text NOT NULL,request_id text NOT NULL,outcome text NOT NULL CHECK(outcome IN ('issued','denied','read','logout')),at_ms bigint NOT NULL);
CREATE INDEX ON hc_security_operational.session(employee_id);
REVOKE ALL ON ALL TABLES IN SCHEMA hc_security_operational FROM PUBLIC;
COMMIT;
