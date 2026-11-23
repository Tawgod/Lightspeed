-- REVIEW ONLY. Isolated Owner staging SECOND and FINAL failed-enrollment recovery.
-- Never run against production or shared PostgreSQL. Apply only with separate
-- explicit approval, fresh verified backup, and a disposable PG18 test pass.
-- Does not issue a code. Preserves the original activation and first reissue
-- audit; creates a second immutable history row for the one final exception.
BEGIN;
DO $scope$
BEGIN
 IF current_database()<>'hc_owner_stage_test'
 OR to_regclass('public.hc_first_owner_activations') IS NULL
 OR to_regclass('public.hc_first_owner_activation_reissues') IS NULL
 OR to_regclass('public.hc_first_owner_activation_events') IS NULL
 OR to_regclass('public.hc_admin_principals') IS NULL
 OR to_regclass('public.hc_staff_passkeys') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_roles
     WHERE rolname='hc_owner_stage_recovery_definer' AND NOT rolcanlogin
       AND NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole AND NOT rolcreatedb)
 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hc_owner_stage_operator_privs')
 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hc_owner_stage_runtime_privs')
 THEN RAISE EXCEPTION 'Second Owner staging recovery schema/scope denied';
 END IF;
END $scope$;

CREATE TABLE public.hc_first_owner_activation_second_recoveries (
 recovery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 employee_id bigint NOT NULL UNIQUE CHECK (employee_id=1),
 first_reissue_id uuid NOT NULL UNIQUE REFERENCES public.hc_first_owner_activation_reissues(reissue_id),
 previous_activation_digest text NOT NULL CHECK(previous_activation_digest ~ '^[a-f0-9]{64}$'),
 previous_approved_at timestamptz NOT NULL,
 previous_expires_at timestamptz NOT NULL,
 previous_issued_by text NOT NULL,
 replacement_activation_digest text NOT NULL CHECK(replacement_activation_digest ~ '^[a-f0-9]{64}$'),
 replacement_approved_at timestamptz NOT NULL,
 replacement_expires_at timestamptz NOT NULL,
 replacement_issued_by text NOT NULL CHECK(
  length(replacement_issued_by) BETWEEN 8 AND 128
  AND replacement_issued_by ~ '^[A-Za-z0-9_.:@-]+$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason text NOT NULL DEFAULT 'first_recovery_enrollment_failed_due_to_verified_digest_bug'
    CHECK (reason='first_recovery_enrollment_failed_due_to_verified_digest_bug'),
 CHECK (previous_expires_at > previous_approved_at),
 CHECK (previous_expires_at < replacement_approved_at),
 CHECK (replacement_expires_at > replacement_approved_at AND
        replacement_expires_at <= replacement_approved_at + interval '10 minutes'),
 CHECK (previous_activation_digest <> replacement_activation_digest)
);

-- The original audit immutable trigger already exists; keep it untouched.
CREATE TRIGGER hc_first_owner_second_recovery_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.hc_first_owner_activation_second_recoveries
 FOR EACH STATEMENT EXECUTE FUNCTION public.hc_first_owner_reissue_audit_immutable();

CREATE FUNCTION public.hc_second_recover_expired_first_owner_activation(
 p_employee_id bigint, p_replacement_digest text, p_operator_ref text
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $second$
DECLARE
 original public.hc_first_owner_activations%ROWTYPE;
 prior public.hc_first_owner_activation_reissues%ROWTYPE;
 approved timestamptz;
 expired timestamptz;
 changed integer;
BEGIN
 IF current_database()<>'hc_owner_stage_test'
    OR p_employee_id IS DISTINCT FROM 1
    OR p_replacement_digest IS NULL
    OR p_replacement_digest !~ '^[a-f0-9]{64}$'
    OR p_operator_ref IS NULL
    OR length(p_operator_ref) NOT BETWEEN 8 AND 128
    OR p_operator_ref !~ '^[A-Za-z0-9_.:@-]+$'
 THEN RAISE EXCEPTION 'Second Owner staging recovery denied'; END IF;

 PERFORM pg_advisory_xact_lock(78619136,801);
 IF (SELECT count(*) FROM public.hc_first_owner_activations)<>1
    OR (SELECT count(*) FROM public.hc_first_owner_activation_reissues)<>1
    OR EXISTS(SELECT 1 FROM public.hc_first_owner_activation_second_recoveries)
    OR EXISTS(SELECT 1 FROM public.hc_admin_principals)
    OR EXISTS(SELECT 1 FROM public.hc_first_owner_activation_events)
    OR EXISTS(SELECT 1 FROM public.hc_staff_passkeys)
 THEN RAISE EXCEPTION 'Second Owner staging recovery denied'; END IF;

 SELECT * INTO original FROM public.hc_first_owner_activations
 WHERE employee_id=p_employee_id FOR UPDATE;
 SELECT * INTO prior FROM public.hc_first_owner_activation_reissues
 WHERE employee_id=p_employee_id;
 approved:=clock_timestamp();
 IF NOT FOUND OR original.employee_id IS NULL
    OR prior.reissue_id IS NULL
    OR original.consumed_at IS NOT NULL
    OR original.credential_id IS NOT NULL
    OR original.expires_at>=approved
    OR original.approved_at>approved
    OR prior.replacement_activation_digest<>original.activation_digest
    OR prior.replacement_approved_at<>original.approved_at
    OR prior.replacement_expires_at<>original.expires_at
    OR prior.replacement_issued_by<>original.issued_by
    OR prior.previous_activation_digest=original.activation_digest
    OR original.activation_digest=p_replacement_digest
    OR prior.previous_activation_digest=p_replacement_digest
 THEN RAISE EXCEPTION 'Second Owner staging recovery denied'; END IF;

 expired:=approved + interval '10 minutes';
 INSERT INTO public.hc_first_owner_activation_second_recoveries (
  employee_id, first_reissue_id,
  previous_activation_digest,previous_approved_at,previous_expires_at,previous_issued_by,
  replacement_activation_digest,replacement_approved_at,replacement_expires_at,replacement_issued_by)
 VALUES (p_employee_id,prior.reissue_id,original.activation_digest,
  original.approved_at,original.expires_at,original.issued_by,
  p_replacement_digest,approved,expired,p_operator_ref);

 UPDATE public.hc_first_owner_activations
 SET activation_digest=p_replacement_digest,approved_at=approved,
     expires_at=expired,issued_by=p_operator_ref
 WHERE employee_id=p_employee_id AND consumed_at IS NULL AND credential_id IS NULL
   AND expires_at<approved AND activation_digest=prior.replacement_activation_digest;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'Second Owner staging recovery denied'; END IF;
 RETURN expired;
END
$second$;

GRANT SELECT ON public.hc_first_owner_activation_second_recoveries
 TO hc_owner_stage_recovery_definer;
GRANT INSERT ON public.hc_first_owner_activation_second_recoveries
 TO hc_owner_stage_recovery_definer;
GRANT CREATE ON SCHEMA public TO hc_owner_stage_recovery_definer;
ALTER FUNCTION public.hc_second_recover_expired_first_owner_activation(bigint,text,text)
 OWNER TO hc_owner_stage_recovery_definer;
REVOKE CREATE ON SCHEMA public FROM hc_owner_stage_recovery_definer;

REVOKE ALL ON TABLE public.hc_first_owner_activation_second_recoveries
 FROM PUBLIC,hc_owner_stage_operator_privs,hc_owner_stage_runtime_privs;
GRANT SELECT ON public.hc_first_owner_activation_second_recoveries
 TO hc_owner_stage_operator_privs;
REVOKE ALL ON FUNCTION public.hc_second_recover_expired_first_owner_activation(bigint,text,text)
 FROM PUBLIC,hc_owner_stage_runtime_privs;
GRANT EXECUTE ON FUNCTION public.hc_second_recover_expired_first_owner_activation(bigint,text,text)
 TO hc_owner_stage_operator_privs;
COMMIT;
