#!/usr/bin/env bash
# Operator-only, exact-service staging SQL. No new backup. No token issuance.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL="$ROOT/db/hc_owner_stage_second_failed_enrollment_recovery.sql"
DB='hc_owner_stage_test'
PROJECT='5b46096d-3178-47ec-ba88-d5037696346a'
SERVICE_ID='5c4498e4-cffb-4224-916a-af57391d1cd9'
KEY="$HOME/.ssh/hc_owner_railway_20261123"
if [[ $# != 1 || "$1" != '--apply-second-owner-staging' || ! -t 0 || ! -t 1 ]]; then
 echo 'Interactive --apply-second-owner-staging required'; exit 2
fi
for c in railway git sha256sum;do command -v "$c" >/dev/null || exit 2;done
[[ -f "$KEY" && -s "$SQL" ]] || { echo 'Missing key or SQL';exit 2; }
[[ "$(git -C "$ROOT" hash-object "$SQL")" == 'e56d51933323765eafa23c980570d23c9f9a3c2c' ]] || {
 echo 'SQL not reviewed version';exit 2;
}
remote() {
 railway ssh -i "$KEY" --project "$PROJECT" --environment staging \
  --service Postgres-x8Ui -- "$@"
}
READ_ONLY="SELECT CASE WHEN current_database()='$DB'
 AND (SELECT count(*) FROM public.hc_first_owner_activations)=1
 AND (SELECT count(*) FROM public.hc_first_owner_activation_reissues)=1
 AND NOT EXISTS(SELECT 1 FROM public.hc_admin_principals)
 AND NOT EXISTS(SELECT 1 FROM public.hc_first_owner_activation_events)
 AND NOT EXISTS(SELECT 1 FROM public.hc_staff_passkeys)
 AND NOT EXISTS(SELECT 1 FROM public.hc_first_owner_activations a
 LEFT JOIN public.hc_first_owner_activation_reissues r ON r.employee_id=a.employee_id
 WHERE a.employee_id<>1 OR r.reissue_id IS NULL OR
  a.activation_digest<>r.replacement_activation_digest OR
  a.approved_at<>r.replacement_approved_at OR
  a.expires_at<>r.replacement_expires_at OR
  a.issued_by<>r.replacement_issued_by OR
  a.consumed_at IS NOT NULL OR a.credential_id IS NOT NULL OR
  a.expires_at>=clock_timestamp())
 AND to_regclass('public.hc_first_owner_activation_second_recoveries') IS NULL
 THEN 'ELIGIBLE' ELSE 'BLOCKED' END"
state="$(remote sh -lc "psql -U postgres -d '$DB' -X -v ON_ERROR_STOP=1 -tAc \"$READ_ONLY\"")"
[[ "$state" == 'ELIGIBLE' ]] || { echo 'HC_OWNER_SECOND_MIGRATION_ELIGIBILITY_BLOCKED';exit 1; }
echo 'HC_OWNER_SECOND_MIGRATION_ELIGIBLE=true'
echo 'Existing offsite backup retained; no new backup requested or made.'
echo 'Applying SQL ONLY to isolated staging Postgres-x8Ui / hc_owner_stage_test.'
echo 'This adds an auditable operator function; it DOES NOT issue a key.'
read -r -p 'Type APPLY SECOND OWNER STAGING SQL to authorize: ' ack
[[ "$ack" == 'APPLY SECOND OWNER STAGING SQL' ]] || { echo 'Declined';exit 1; }
scratch="$(mktemp -d)"
target="/tmp/hc-owner-second-recovery-$$.sql"
uploaded=0
cleanup() {
 if [[ "$uploaded" == 1 ]];then remote sh -lc "rm -f -- '$target'" >/dev/null 2>&1 || true;fi
 rm -rf "$scratch"
}
trap cleanup EXIT
(
 cd "$scratch"
 railway link --project "$PROJECT" --environment staging --service "$SERVICE_ID" --json >/dev/null
 railway service files upload "$SQL" "$target"
)
uploaded=1
local_sha="$(sha256sum "$SQL" | cut -d' ' -f1)"
remote sh -lc "set -eu; test \"\$(sha256sum '$target' | cut -d' ' -f1)\" = '$local_sha'; psql -U postgres -d '$DB' -X -v ON_ERROR_STOP=1 -q -f '$target'"
CHECK="SELECT CASE WHEN
 current_database()='$DB'
 AND pg_get_userbyid(p.proowner)='hc_owner_stage_recovery_definer'
 AND NOT has_schema_privilege('hc_owner_stage_recovery_definer','public','CREATE')
 AND has_function_privilege('hc_owner_stage_operator_privs',
 'public.hc_second_recover_expired_first_owner_activation(bigint,text,text)','EXECUTE')
 AND NOT has_function_privilege('hc_owner_stage_runtime_privs',
 'public.hc_second_recover_expired_first_owner_activation(bigint,text,text)','EXECUTE')
 AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
 AND (SELECT count(*) FROM public.hc_first_owner_activation_second_recoveries)=0
 AND (SELECT count(*) FROM public.hc_first_owner_activation_reissues)=1
 AND NOT EXISTS(SELECT 1 FROM public.hc_admin_principals)
 THEN 'VERIFIED' ELSE 'FAILED' END
 FROM pg_proc p WHERE p.oid=
 'public.hc_second_recover_expired_first_owner_activation(bigint,text,text)'::regprocedure"
out="$(remote sh -lc "psql -U postgres -d '$DB' -X -v ON_ERROR_STOP=1 -tAc \"$CHECK\"")" || {
 echo 'Migration may have committed; readback failed. DO NOT rerun';exit 1;
}
[[ "$out" == 'VERIFIED' ]] || {
 echo 'Migration may have committed; privilege check blocked. DO NOT rerun';exit 1;
}
echo 'HC_OWNER_SECOND_STAGE_SQL_MIGRATED_VERIFIED=true'
echo 'NO_ACTIVATION_ISSUED=true'
