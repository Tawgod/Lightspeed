-- CI-only minimal compatibility fixture for the source-owned Admin grant tables.
-- The authoritative production schema remains on the Employee Admin branch at
-- db/hc_admin_delegations.sql. Never apply this fixture to Railway or production.
CREATE TABLE hc_admin_principals (
 employee_id bigint PRIMARY KEY CHECK(employee_id>0),
 role text NOT NULL CHECK(role IN ('owner','delegated_admin')),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1
);
CREATE TABLE hc_admin_grants (
 employee_id bigint NOT NULL REFERENCES hc_admin_principals(employee_id),
 operation text NOT NULL,
 PRIMARY KEY(employee_id,operation)
);
