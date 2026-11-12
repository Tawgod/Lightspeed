-- Isolated Admin navigation permission role contract.
-- REVIEW ONLY: never run this against existing Timeclock, production, or
-- shared staff-security PostgreSQL databases.
--
-- The canonical schema is db/hc_admin_delegations.sql on the Employee Admin
-- feature branch. Apply it through a separately approved isolated migration.
-- The login role should be created with a separately generated credential
-- via an approved secrets manager; NEVER hardcode a password here.
--
-- After approved schema creation, run the statements below as the dedicated
-- schema owner in the NEW isolated admin database. This script does not
-- provision any Owner or delegated administrator identities.
DO $$
BEGIN
  IF to_regclass('public.hc_admin_principals') IS NULL OR
     to_regclass('public.hc_admin_grants') IS NULL THEN
    RAISE EXCEPTION 'Admin schema must be approved and installed first';
  END IF;
END $$;

-- NOLOGIN by default. Granting LOGIN + setting a generated password is
-- a separate, explicitly approved secrets-management step.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hc_admin_nav_reader') THEN
    CREATE ROLE hc_admin_nav_reader NOLOGIN;
  END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM hc_admin_nav_reader;
GRANT USAGE ON SCHEMA public TO hc_admin_nav_reader;
REVOKE ALL ON TABLE public.hc_admin_principals,public.hc_admin_grants
  FROM hc_admin_nav_reader;
GRANT SELECT ON TABLE public.hc_admin_principals,public.hc_admin_grants
  TO hc_admin_nav_reader;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Ensure the default schema used by the reader is public and it cannot
-- perform any DML, schema creation, grant changes, or owner commissioning.
ALTER ROLE hc_admin_nav_reader SET search_path TO public;
