-- Disposable S2.5M candidate only. NOT an approved hosted migration.
CREATE SCHEMA hc_s25m;
CREATE TABLE hc_s25m.authority (singleton boolean PRIMARY KEY CHECK(singleton), policy_revision integer NOT NULL CHECK(policy_revision>0), evidence_revision integer NOT NULL CHECK(evidence_revision>0));
INSERT INTO hc_s25m.authority VALUES(true,1,1);
CREATE TABLE hc_s25m.employee (id text PRIMARY KEY, active boolean NOT NULL, policy jsonb NOT NULL);
CREATE TABLE hc_s25m.session (id text PRIMARY KEY, employee_id text NOT NULL REFERENCES hc_s25m.employee(id), policy_revision integer NOT NULL, evidence_revision integer NOT NULL, evidence jsonb NOT NULL, revoked boolean NOT NULL DEFAULT false);
CREATE TABLE hc_s25m.approval (id text PRIMARY KEY, actor text NOT NULL REFERENCES hc_s25m.employee(id), reviewer text NOT NULL REFERENCES hc_s25m.employee(id), digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), expires_at bigint NOT NULL, revoked boolean NOT NULL DEFAULT false, CHECK(actor<>reviewer));
CREATE TABLE hc_s25m.note (id text PRIMARY KEY, label text NOT NULL, revision integer NOT NULL CHECK(revision>0));
CREATE TABLE hc_s25m.receipt (key text PRIMARY KEY, actor text NOT NULL REFERENCES hc_s25m.employee(id), digest text NOT NULL, approval_id text NOT NULL REFERENCES hc_s25m.approval(id), resource text NOT NULL REFERENCES hc_s25m.note(id), revision integer NOT NULL);
CREATE TABLE hc_s25m.audit (id uuid PRIMARY KEY, actor text, operation text NOT NULL, resource text, outcome text NOT NULL, policy_revision integer NOT NULL, evidence_revision integer NOT NULL, at_ms bigint NOT NULL);
REVOKE ALL ON SCHEMA hc_s25m FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA hc_s25m FROM PUBLIC;
