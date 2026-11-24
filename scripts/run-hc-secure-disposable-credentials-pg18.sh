#!/usr/bin/env bash
# HC Secure real credential verification, ephemeral PostgreSQL 18 ONLY.
# Does not connect to Railway. Uses a localhost-bound disposable container.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo "Docker is required."; exit 1; }
command -v openssl >/dev/null || { echo "OpenSSL is required."; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is unavailable."; exit 1; }
if [[ -n "${RAILWAY_PROJECT_ID:-}" || -n "${RAILWAY_ENVIRONMENT_ID:-}" || -n "${RAILWAY_SERVICE_ID:-}" ]]; then
 echo "Refusing inside Railway environment."; exit 1
fi
if [[ -n "${DATABASE_URL:-}" || -n "${HC_OWNER_STAGING_DATABASE_URL:-}" ]]; then
 echo "Refusing when existing Owner/business DB credentials are present."; exit 1
fi
name="hc-secure-credential-disposable-$$"
password="$(openssl rand -hex 24)"
cleanup(){
 docker rm -f "$name" >/dev/null 2>&1 || true
 unset POSTGRES_PASSWORD HC_SECURE_DISPOSABLE_DATABASE_URL HC_SECURE_DISPOSABLE_CREDENTIAL_TEST password
}
trap cleanup EXIT INT TERM
export POSTGRES_PASSWORD="$password"
docker run --rm -d \
 --name "$name" \
 --network bridge \
 --mount type=tmpfs,destination=/var/lib/postgresql \
 -p 127.0.0.1:15489:5432 \
 -e POSTGRES_PASSWORD \
 -e POSTGRES_DB=hc_owner_stage_test \
 postgres:18 \
 -c cluster_name=hc-secure-credentials-disposable-pg18 >/dev/null
for i in $(seq 1 45); do
 if docker exec "$name" pg_isready -U postgres -d hc_owner_stage_test -q >/dev/null 2>&1; then break; fi
 if [[ "$i" == "45" ]]; then echo "Disposable PostgreSQL startup timed out."; exit 1; fi
 sleep 1
done
export HC_SECURE_DISPOSABLE_CREDENTIAL_TEST=true
export HC_SECURE_DISPOSABLE_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:15489/hc_owner_stage_test"
node scripts/test-hc-secure-credentials-disposable.mjs
echo 'HC_SECURE_CREDENTIAL_CONTAINER_CLEANUP_PENDING=true'
