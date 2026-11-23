#!/usr/bin/env bash
# Read-only preflight of real Timeclock identity and restricted operator DB login.
# All commands execute INSIDE existing isolated Railway services. No secrets
# are copied into Codespaces and the single recovery is not invoked.
set -Eeuo pipefail

PROJECT='5b46096d-3178-47ec-ba88-d5037696346a'
ENV='46b93c76-3085-4e76-a37d-90dfdd250dd2'
[[ "$#" -eq 0 ]] || { echo 'Usage: bash scripts/preflight-owner-stage-activation-live.sh' >&2; exit 2; }
command -v railway >/dev/null || { echo 'Railway CLI is required' >&2; exit 1; }

# Optional explicit private key: Railway may otherwise pick a locked older key.
SSH_KEY="${HC_OWNER_RAILWAY_SSH_KEY:-}"
SSH_OPTS=()
if [[ -n "$SSH_KEY" ]]; then
  [[ -f "$SSH_KEY" && -f "$SSH_KEY.pub" ]] || {
    echo 'Specified Railway SSH key or public key file missing' >&2; exit 1;
  }
  SSH_OPTS=(-i "$SSH_KEY")
fi

APP_REMOTE=$(cat <<'REMOTE_APP'
set -eu
if test -f /app/services/scannerTimeclockIdentity.js; then
  cd /app
elif ! test -f ./services/scannerTimeclockIdentity.js; then
  echo 'HC_OWNER_TIMECLOCK_PREFLIGHT_BLOCKED: deployment missing identity module' >&2
  exit 2
fi
node --input-type=module <<'NODE'
import {pathToFileURL} from 'node:url';
const env=process.env;
try {
  if(env.NODE_ENV!=='test' ||
     env.HC_SECURITY_ENV!=='isolated-staging' ||
     env.HC_OWNER_STAGING_ENABLED!=='true' ||
     env.HC_OWNER_TIMECLOCK_EMPLOYEE_ID!=='1') throw Error('config');
  const {createTimeclockScannerIdentity}=await import(
    pathToFileURL(process.cwd()+'/services/scannerTimeclockIdentity.js'));
  const identity=createTimeclockScannerIdentity({
    baseUrl:env.HC_OWNER_TIMECLOCK_ORIGIN,
    serviceSecret:env.HC_OWNER_TIMECLOCK_SERVICE_SECRET,
    mode:'owner-staging'
  });
  const person=await identity.authorize('1');
  if(String(person?.id)!=='1' ||
     person?.permissionSource!=='timeclock_employee' ||
     person?.canLookup!==true) throw Error('identity');
  console.log('HC_OWNER_TIMECLOCK_PREFLIGHT_OK');
} catch {
  console.error('HC_OWNER_TIMECLOCK_PREFLIGHT_BLOCKED');
  process.exitCode=1;
}
NODE
REMOTE_APP
)

DB_REMOTE=$(cat <<'REMOTE_DB'
set -eu
DB='hc_owner_stage_test'
if ! printenv HC_OWNER_OPERATOR_DB_PASSWORD >/dev/null; then
  echo 'HC_OWNER_OPERATOR_PREFLIGHT_BLOCKED: DB password missing' >&2
  exit 2
fi
SQL="SELECT CASE WHEN current_database()='hc_owner_stage_test'
  AND (SELECT COUNT(*) FROM public.hc_first_owner_activations)=1
  AND EXISTS (
    SELECT 1 FROM public.hc_first_owner_activations
    WHERE employee_id=1 AND consumed_at IS NULL AND credential_id IS NULL
      AND expires_at < clock_timestamp())
  AND NOT EXISTS (SELECT 1 FROM public.hc_admin_principals)
  AND NOT EXISTS (SELECT 1 FROM public.hc_first_owner_activation_events)
  AND NOT EXISTS (SELECT 1 FROM public.hc_first_owner_activation_reissues)
  AND NOT EXISTS (SELECT 1 FROM public.hc_staff_passkeys WHERE employee_id=1)
  AND to_regprocedure('public.hc_reissue_expired_first_owner_activation(bigint,text,text)') IS NOT NULL
  THEN 'HC_OWNER_RECOVERY_UNUSED'
  ELSE 'HC_OWNER_RECOVERY_NOT_ELIGIBLE' END;"
STATE="$(psql -X -U postgres -d "$DB" -v ON_ERROR_STOP=1 -tAc "$SQL")"
[ "$STATE" = 'HC_OWNER_RECOVERY_UNUSED' ] || {
  echo 'HC_OWNER_OPERATOR_PREFLIGHT_BLOCKED: recovery no longer eligible' >&2
  exit 2
}
ROLE_SQL="SELECT r.rolname
 FROM pg_catalog.pg_roles r
 JOIN pg_catalog.pg_auth_members m ON m.member=r.oid
 JOIN pg_catalog.pg_roles g ON m.roleid=g.oid
 WHERE g.rolname='hc_owner_stage_operator_privs'
 AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
 AND NOT r.rolcreaterole AND NOT r.rolreplication
 AND NOT r.rolbypassrls
 AND NOT EXISTS(
   SELECT 1 FROM pg_catalog.pg_auth_members x
   JOIN pg_catalog.pg_roles rt ON rt.oid=x.roleid
   WHERE x.member=r.oid AND rt.rolname='hc_owner_stage_runtime_privs'
 );"
ROLES="$(psql -X -U postgres -d "$DB" -v ON_ERROR_STOP=1 -tAc "$ROLE_SQL")"
[ -n "$ROLES" ] && [ "$(printf '%s\n' "$ROLES" | wc -l | tr -d ' ')" = 1 ] || {
  echo 'HC_OWNER_OPERATOR_PREFLIGHT_BLOCKED: operator role not unique' >&2
  exit 2
}
ROLE="$ROLES"
CHECK="SELECT CASE WHEN current_user='$ROLE'
 AND has_function_privilege(current_user,
    'public.hc_reissue_expired_first_owner_activation(bigint,text,text)', 'EXECUTE')
 AND NOT has_table_privilege(current_user,
    'public.hc_staff_totp','SELECT')
 AND NOT has_table_privilege(current_user,
    'public.hc_admin_principals','INSERT')
 THEN 'HC_OWNER_OPERATOR_LOGIN_OK'
 ELSE 'HC_OWNER_OPERATOR_LOGIN_DENIED' END;"
CHECKED="$(PGPASSWORD="$HC_OWNER_OPERATOR_DB_PASSWORD" psql -X \
  -h 127.0.0.1 -U "$ROLE" -d "$DB" -v ON_ERROR_STOP=1 -tAc "$CHECK")"
[ "$CHECKED" = 'HC_OWNER_OPERATOR_LOGIN_OK' ] || {
  echo 'HC_OWNER_OPERATOR_PREFLIGHT_BLOCKED: login/permission mismatch' >&2
  exit 2
}
echo 'HC_OWNER_OPERATOR_PREFLIGHT_OK'
REMOTE_DB
)

echo 'Checking deployed staging Timeclock identity inside Railway.'
if ! railway ssh "${SSH_OPTS[@]}" --project "$PROJECT" --environment "$ENV" \
    --service hc-owner-staging -- sh -lc "$APP_REMOTE"; then
  echo 'STOP: Timeclock lookup unavailable. No recovery issued.' >&2
  exit 1
fi

echo 'Checking unused recovery and restricted operator login inside dedicated PostgreSQL.'
if ! railway ssh "${SSH_OPTS[@]}" --project "$PROJECT" --environment "$ENV" \
    --service Postgres-x8Ui -- sh -lc "$DB_REMOTE"; then
  echo 'STOP: restricted DB operator check failed. No recovery issued.' >&2
  exit 1
fi

echo 'HC_OWNER_PRIVATE_ACTIVATION_PREFLIGHT_OK=true'
echo 'READ_ONLY=true'
echo 'No recovery activation was issued.'
