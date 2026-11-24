#!/usr/bin/env bash
# Disposable PG18 test only. Creates a temporary local Docker container,
# never opens or changes Railway, and ALWAYS removes container on exit.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo "Docker is not available in this Codespace."; exit 1; }
command -v openssl >/dev/null || { echo "OpenSSL is required."; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon not running."; exit 1; }
container="hc-secure-pg18-disposable-$$"
if [[ -n "${RAILWAY_PROJECT_ID:-}" || -n "${RAILWAY_ENVIRONMENT_ID:-}" || -n "${RAILWAY_SERVICE_ID:-}" ]]; then
 echo "Cannot run disposable schema harness inside a Railway service."
 exit 1
fi
pass="$(openssl rand -hex 24)"
cleanup(){
 docker rm -f "$container" >/dev/null 2>&1 || true
 unset HC_SECURE_DISPOSABLE_DATABASE_URL HC_SECURE_DISPOSABLE_SCHEMA_TEST POSTGRES_PASSWORD pass
}
trap cleanup EXIT INT TERM
export POSTGRES_PASSWORD="$pass"
docker run --rm -d \
 --name "$container" \
 --network bridge \
 --mount type=tmpfs,destination=/var/lib/postgresql \
 -p 127.0.0.1:15488:5432 \
 -e POSTGRES_PASSWORD \
 -e POSTGRES_DB=hc_owner_stage_test \
 postgres:18 \
 -c cluster_name=hc-secure-disposable-pg18 >/dev/null
for i in $(seq 1 45); do
 if docker exec "$container" pg_isready -U postgres -d hc_owner_stage_test -q >/dev/null 2>&1; then break; fi
 if [[ "$i" == "45" ]]; then echo "Disposable PostgreSQL 18 startup timed out."; exit 1; fi
 sleep 1
done
export HC_SECURE_DISPOSABLE_SCHEMA_TEST=true
export HC_SECURE_DISPOSABLE_DATABASE_URL="postgresql://postgres:${pass}@127.0.0.1:15488/hc_owner_stage_test"
unset RAILWAY_PROJECT_ID RAILWAY_ENVIRONMENT_ID RAILWAY_SERVICE_ID
# First run checks real PG18 SQL, tables and grants, then rolls back.
node scripts/test-hc-secure-schema-disposable.mjs
# Second run proves the first test left no schema or roles.
node scripts/test-hc-secure-schema-disposable.mjs
echo "HC_SECURE_DISPOSABLE_PG18_DOUBLE_PASS=true (no persistent DB or credentials)"
