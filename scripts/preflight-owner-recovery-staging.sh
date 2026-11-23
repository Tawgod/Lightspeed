#!/usr/bin/env bash
# Read-only, isolated Owner staging recovery migration preflight.
# Does not issue an activation or apply any SQL.
set -Eeuo pipefail

PROJECT='5b46096d-3178-47ec-ba88-d5037696346a'
ENVIRONMENT='46b93c76-3085-4e76-a37d-90dfdd250dd2'
SERVICE='Postgres-x8Ui'
DATABASE='hc_owner_stage_test'

if [[ $# -ne 0 ]]; then
  echo 'Usage: bash scripts/preflight-owner-recovery-staging.sh' >&2
  exit 2
fi
command -v railway >/dev/null || { echo 'Railway CLI is required.' >&2; exit 1; }

# One aggregate boolean: no personal data, original token digest,
# activation codes or credentials are returned.
SQL="SELECT CASE WHEN
  current_database()='hc_owner_stage_test'
  AND current_user='postgres'
  AND current_setting('server_version_num')::integer BETWEEN 180000 AND 189999
  AND (SELECT count(*) FROM public.hc_first_owner_activations)=1
  AND EXISTS (
    SELECT 1 FROM public.hc_first_owner_activations
    WHERE employee_id=1
      AND consumed_at IS NULL
      AND credential_id IS NULL
      AND approved_at < clock_timestamp()
      AND expires_at < clock_timestamp())
  AND NOT EXISTS (SELECT 1 FROM public.hc_admin_principals)
  AND NOT EXISTS (SELECT 1 FROM public.hc_first_owner_activation_events)
  AND NOT EXISTS (SELECT 1 FROM public.hc_staff_passkeys WHERE employee_id=1)
  AND to_regclass('public.hc_first_owner_activation_reissues') IS NULL
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hc_owner_stage_operator_privs' AND NOT rolcanlogin AND NOT rolsuper)
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hc_owner_stage_runtime_privs' AND NOT rolcanlogin AND NOT rolsuper)
  THEN 'HC_OWNER_STAGING_RECOVERY_PREFLIGHT_OK'
  ELSE 'HC_OWNER_STAGING_RECOVERY_PREFLIGHT_BLOCKED' END;"

echo 'Running read-only check against isolated Postgres-x8Ui / hc_owner_stage_test.'
if ! out="$(railway ssh --project "$PROJECT" --environment "$ENVIRONMENT" \
  --service "$SERVICE" -- sh -lc \
  "psql -U postgres -d '$DATABASE' -X -v ON_ERROR_STOP=1 -tAc \"$SQL\"")"; then
  echo 'HC_OWNER_STAGING_RECOVERY_PREFLIGHT_BLOCKED: SQL or connection failed.' >&2
  exit 1
fi
if ! printf '%s\n' "$out" | grep -qx 'HC_OWNER_STAGING_RECOVERY_PREFLIGHT_OK'; then
  echo 'HC_OWNER_STAGING_RECOVERY_PREFLIGHT_BLOCKED: actual database state is not eligible.' >&2
  exit 1
fi
echo 'HC_OWNER_STAGING_RECOVERY_PREFLIGHT_OK'
echo 'READ_ONLY_PREFLIGHT_COMPLETE=true'
echo 'No staging database mutation, migration or activation was performed.'
