#!/usr/bin/env bash
# Explicit, staging-only, reviewed SQL migration. NOT a deployment or token issuer.
set -Eeuo pipefail
umask 077

PROJECT='5b46096d-3178-47ec-ba88-d5037696346a'
ENVIRONMENT='46b93c76-3085-4e76-a37d-90dfdd250dd2'
SERVICE='Postgres-x8Ui'
SERVICE_ID='5c4498e4-cffb-4224-916a-af57391d1cd9'
DATABASE='hc_owner_stage_test'
BRANCH='feature/owner-expired-activation-recovery-20261113'
SQL_BLOB='b27bd4a162c8337b1e969c3ad9a3bf464d3872f1'
BACKUP_SHA='2342d2443084c4c432a05d81532953acb7acf5d2f6d3fc66ddfcde70f9049bee'
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL_FILE="$ROOT/db/hc_owner_stage_expired_activation_recovery.sql"
BACKUP="$HOME/hc-owner-private-backups/hc-owner-stage-20261113T204750Z-64857.dump.age"

if [[ $# -ne 1 || "$1" != '--apply-approved-staging-sql' ]]; then
  echo 'This is a write operation. Use only after explicit user approval.' >&2
  echo 'Usage: bash scripts/apply-owner-recovery-staging-sql.sh --apply-approved-staging-sql' >&2
  exit 2
fi
if [[ ! -t 0 || ! -t 1 || "$HC_OWNER_STAGING_MIGRATION_APPROVAL" != 'APPROVED_ISOLATED_STAGE_SQL_ONLY' ]]; then
  echo 'Refusing: interactive session and scoped approval acknowledgement required.' >&2
  exit 1
fi
for cmd in railway git sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing $cmd" >&2; exit 1; }
done
if [[ "$(git -C "$ROOT" branch --show-current)" != "$BRANCH" ||
      "$(git -C "$ROOT" hash-object "$SQL_FILE")" != "$SQL_BLOB" ||
      ! -s "$BACKUP" ||
      "$(sha256sum "$BACKUP" | cut -d' ' -f1)" != "$BACKUP_SHA" ]]; then
  echo 'Refusing: source branch, reviewed SQL or exact verified encrypted backup mismatch.' >&2
  exit 1
fi

# Re-check live state immediately before any SQL write.
bash "$ROOT/scripts/preflight-owner-recovery-staging.sh"
echo 'This will apply ONLY db/hc_owner_stage_expired_activation_recovery.sql'
echo 'to HC PR63 Isolated Staging / staging / Postgres-x8Ui / hc_owner_stage_test.'
echo 'It adds the audited, one-use recovery function, but does NOT issue a token.'
read -r -p 'Type APPLY OWNER STAGING SQL to confirm: ' answer
if [[ "$answer" != 'APPLY OWNER STAGING SQL' ]]; then
  echo 'Declined: nothing applied.'
  exit 1
fi

LINK_DIR="$(mktemp -d)"
REMOTE="/tmp/hc-owner-recovery-migration-$$.sql"
REMOTE_READY=0
railway_command(){
  railway ssh --project "$PROJECT" --environment "$ENVIRONMENT" \
    --service "$SERVICE" -- "$@"
}
cleanup(){
  if [[ "$REMOTE_READY" -eq 1 ]]; then
    railway_command sh -lc "rm -f -- '$REMOTE'" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$LINK_DIR"
}
trap cleanup EXIT

# Staging service is selected by exact service UUID in an isolated CLI link
# so the repository's own Railway link is never overwritten.
(
  cd "$LINK_DIR"
  railway link --project "$PROJECT" --environment "$ENVIRONMENT" \
    --service "$SERVICE_ID" --json >/dev/null
  railway service files upload "$SQL_FILE" "$REMOTE"
)
REMOTE_READY=1
LOCAL_SHA="$(sha256sum "$SQL_FILE" | cut -d' ' -f1)"

# The migration file itself contains BEGIN; ... COMMIT; and fail-fast guard.
# SQL errors prevent commit. No SQL changes to production or other databases.
railway_command sh -lc "
  set -eu
  test \"\$(sha256sum '$REMOTE' | cut -d' ' -f1)\" = '$LOCAL_SHA'
  psql -U postgres -d '$DATABASE' -X -v ON_ERROR_STOP=1 -q -f '$REMOTE'
"

# Post-commit readback is not activation; returns only status without data.
VERIFY_SQL="SELECT CASE WHEN
 current_database()='hc_owner_stage_test'
 AND pg_get_userbyid(p.proowner)='hc_owner_stage_recovery_definer'
 AND NOT EXISTS (
   SELECT 1 FROM pg_roles WHERE rolname='hc_owner_stage_recovery_definer'
   AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolinherit))
 AND NOT has_schema_privilege('hc_owner_stage_recovery_definer','public','CREATE')
 AND has_function_privilege('hc_owner_stage_operator_privs',
   'public.hc_reissue_expired_first_owner_activation(bigint,text,text)','EXECUTE')
 AND NOT has_function_privilege('hc_owner_stage_runtime_privs',
   'public.hc_reissue_expired_first_owner_activation(bigint,text,text)','EXECUTE')
 AND NOT has_function_privilege('public',
   'public.hc_reissue_expired_first_owner_activation(bigint,text,text)','EXECUTE')
 AND (SELECT count(*) FROM public.hc_first_owner_activations)=1
 AND NOT EXISTS(SELECT 1 FROM public.hc_first_owner_activation_reissues)
 AND NOT EXISTS(SELECT 1 FROM public.hc_admin_principals)
 THEN 'HC_OWNER_STAGE_SQL_VERIFIED'
 ELSE 'HC_OWNER_STAGE_SQL_CHECK_FAILED' END
 FROM pg_proc p
 WHERE p.oid='public.hc_reissue_expired_first_owner_activation(bigint,text,text)'::regprocedure;"

if ! AFTER="$(railway_command sh -lc \
   "psql -U postgres -d '$DATABASE' -X -v ON_ERROR_STOP=1 -tAc \"$VERIFY_SQL\"")"; then
  echo 'Migration may have committed, but readback failed. Do not rerun blindly.' >&2
  exit 1
fi
if ! printf '%s\n' "$AFTER" | grep -qx 'HC_OWNER_STAGE_SQL_VERIFIED'; then
  echo 'Migration may have committed, but permission readback was not verified. Stop.' >&2
  exit 1
fi
echo 'HC_OWNER_STAGE_SQL_MIGRATED_VERIFIED=true'
echo 'No activation token, Owner account or passkey was created.'
