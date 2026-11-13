-- PROPOSAL ONLY: apply to the isolated HC PR63 Owner staging PostgreSQL database
-- only after independent review, backup and explicit migration approval.
-- Never apply to production Timeclock, shared/core PG, or as app startup SQL.
-- Recovery is intentionally LIMITED TO ONE expired, unconsumed first-Owner
-- authorization. Prior SHA-256 digest, timestamps and issuer are preserved.
-- The public web runtime cannot execute this function or issue an activation.
BEGIN;

DO $guard$
BEGIN
  IF current_database() <> 'hc_owner_stage_test' THEN
    RAISE EXCEPTION 'Only the isolated Owner staging database is permitted';
  END IF;
  IF to_regclass('public.hc_first_owner_activations') IS NULL OR
     to_regclass('public.hc_first_owner_activation_events') IS NULL OR
     to_regclass('public.hc_admin_principals') IS NULL OR
     to_regclass('public.hc_staff_passkeys') IS NULL OR
     NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hc_owner_stage_operator_privs') OR
     NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hc_owner_stage_runtime_privs') THEN
    RAISE EXCEPTION 'Reviewed Owner staging schema and privilege groups required';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.hc_first_owner_activation_reissues (
  reissue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id bigint NOT NULL CHECK (employee_id > 0),
  previous_activation_digest text NOT NULL
    CHECK (previous_activation_digest ~ '^[a-f0-9]{64}$'),
  previous_approved_at timestamptz NOT NULL,
  previous_expires_at timestamptz NOT NULL,
  previous_issued_by text NOT NULL,
  replacement_activation_digest text NOT NULL
    CHECK (replacement_activation_digest ~ '^[a-f0-9]{64}$'),
  replacement_approved_at timestamptz NOT NULL,
  replacement_expires_at timestamptz NOT NULL,
  replacement_issued_by text NOT NULL
    CHECK (length(replacement_issued_by) BETWEEN 8 AND 128 AND
           replacement_issued_by ~ '^[A-Za-z0-9_.:@-]+$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (previous_expires_at > previous_approved_at),
  CHECK (previous_expires_at < replacement_approved_at),
  CHECK (replacement_expires_at > replacement_approved_at AND
         replacement_expires_at <= replacement_approved_at + interval '10 minutes'),
  CHECK (previous_activation_digest <> replacement_activation_digest)
);

CREATE UNIQUE INDEX IF NOT EXISTS hc_first_owner_one_reissue_only
 ON public.hc_first_owner_activation_reissues (employee_id);

CREATE OR REPLACE FUNCTION public.hc_first_owner_reissue_audit_immutable()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $immutable$
BEGIN
  RAISE EXCEPTION 'First Owner reissue audit is append-only';
END
$immutable$;

DROP TRIGGER IF EXISTS hc_first_owner_reissue_audit_immutable
 ON public.hc_first_owner_activation_reissues;
CREATE TRIGGER hc_first_owner_reissue_audit_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.hc_first_owner_activation_reissues
 FOR EACH STATEMENT EXECUTE FUNCTION
 public.hc_first_owner_reissue_audit_immutable();

-- A narrow SECURITY DEFINER operation is necessary because the existing
-- operator role is INSERT+SELECT only; it must NOT gain arbitrary UPDATE on
-- activation facts, and the runtime role must keep consumption-only UPDATE.
-- The independent operator re-verifies canonical Timeclock identity locally
-- in scripts/issue-owner-stage-activation.mjs before calling this function.
CREATE OR REPLACE FUNCTION public.hc_reissue_expired_first_owner_activation(
  p_employee_id bigint,
  p_replacement_digest text,
  p_operator_ref text
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $recover$
DECLARE
  previous public.hc_first_owner_activations%ROWTYPE;
  new_approved_at timestamptz;
  new_expires_at timestamptz;
  changed integer;
BEGIN
  IF current_database() <> 'hc_owner_stage_test' OR
     p_employee_id IS NULL OR p_employee_id < 1 OR p_employee_id = 901 OR
     p_replacement_digest IS NULL OR
     p_replacement_digest !~ '^[a-f0-9]{64}$' OR
     p_operator_ref IS NULL OR
     length(p_operator_ref) NOT BETWEEN 8 AND 128 OR
     p_operator_ref !~ '^[A-Za-z0-9_.:@-]+$' THEN
    RAISE EXCEPTION 'First Owner activation recovery denied';
  END IF;

  -- Cooperates with first-Owner registration/initial issuance transactions.
  PERFORM pg_advisory_xact_lock(78619136, 801);
  IF (SELECT count(*) FROM public.hc_first_owner_activations) <> 1 OR
     EXISTS (SELECT 1 FROM public.hc_admin_principals) OR
     EXISTS (SELECT 1 FROM public.hc_first_owner_activation_events) OR
     EXISTS (SELECT 1 FROM public.hc_first_owner_activation_reissues) OR
     EXISTS (SELECT 1 FROM public.hc_staff_passkeys
             WHERE employee_id = p_employee_id) THEN
    RAISE EXCEPTION 'First Owner activation recovery denied';
  END IF;

  SELECT * INTO previous
    FROM public.hc_first_owner_activations
    WHERE employee_id = p_employee_id
    FOR UPDATE;
  new_approved_at := clock_timestamp();
  IF NOT FOUND OR
     previous.consumed_at IS NOT NULL OR
     previous.credential_id IS NOT NULL OR
     previous.expires_at >= new_approved_at OR
     previous.approved_at > new_approved_at OR
     previous.activation_digest = p_replacement_digest THEN
    RAISE EXCEPTION 'First Owner activation recovery denied';
  END IF;

  new_expires_at := new_approved_at + interval '10 minutes';
  INSERT INTO public.hc_first_owner_activation_reissues
    (employee_id, previous_activation_digest,
     previous_approved_at, previous_expires_at, previous_issued_by,
     replacement_activation_digest, replacement_approved_at,
     replacement_expires_at, replacement_issued_by)
  VALUES
    (p_employee_id, previous.activation_digest,
     previous.approved_at, previous.expires_at, previous.issued_by,
     p_replacement_digest, new_approved_at, new_expires_at, p_operator_ref);

  UPDATE public.hc_first_owner_activations
     SET activation_digest = p_replacement_digest,
         approved_at = new_approved_at,
         expires_at = new_expires_at,
         issued_by = p_operator_ref
   WHERE employee_id = p_employee_id
     AND consumed_at IS NULL AND credential_id IS NULL
     AND expires_at < new_approved_at;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'First Owner activation recovery denied';
  END IF;
  RETURN new_expires_at;
END
$recover$;

REVOKE ALL ON TABLE public.hc_first_owner_activation_reissues
 FROM PUBLIC, hc_owner_stage_runtime_privs, hc_owner_stage_operator_privs;
GRANT SELECT ON TABLE public.hc_first_owner_activation_reissues
 TO hc_owner_stage_operator_privs;
REVOKE ALL ON FUNCTION public.hc_reissue_expired_first_owner_activation(bigint,text,text)
 FROM PUBLIC, hc_owner_stage_runtime_privs;
GRANT EXECUTE ON FUNCTION public.hc_reissue_expired_first_owner_activation(bigint,text,text)
 TO hc_owner_stage_operator_privs;
-- No permission granted to the public runtime on the recovery function.
COMMIT;
