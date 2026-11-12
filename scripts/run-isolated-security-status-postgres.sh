#!/usr/bin/env bash
# Manual-only staging verification. Runs disposable PostgreSQL inside the
# Codespace cloud; NEVER connects to Railway or reads a user's DATABASE_URL.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is unavailable in this Codespace. No database was touched." >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "The Codespace Docker daemon is not running. No database was touched." >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js must be installed in Codespaces." >&2
  exit 2
fi
if ! node --check tests/core-operations-status-postgres-isolated.test.mjs; then
  echo "Local-only test failed JavaScript syntax validation; no database was started." >&2
  exit 2
fi
if ! npm ls express pg --depth=0 >/dev/null 2>&1; then
  echo "Missing project dependencies in Codespaces. Install npm packages there first." >&2
  exit 2
fi

CONTAINER_ID=""
cleanup() {
  local result=$?
  if [[ -n "$CONTAINER_ID" && "$CONTAINER_ID" =~ ^[0-9a-f]{12,64}$ ]]; then
    if ! docker info >/dev/null 2>&1; then
      echo "WARNING: Docker is unavailable; could not verify disposable container cleanup." >&2
      return 1
    fi
    if docker inspect "$CONTAINER_ID" >/dev/null 2>&1; then
      if ! docker rm -f "$CONTAINER_ID" >/dev/null 2>&1; then
        echo "WARNING: Could not remove the disposable PostgreSQL test container." >&2
        return 1
      fi
    fi
    if docker inspect "$CONTAINER_ID" >/dev/null 2>&1; then
      echo "WARNING: Disposable PostgreSQL container still exists after cleanup." >&2
      return 1
    fi
    echo "Verified disposable PostgreSQL container removal."
  fi
  return "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

name="hc-security-disposable-$RANDOM-$$"
echo "Starting a LOCAL, DISPOSABLE PostgreSQL 18 test container in Codespaces."
CONTAINER_ID="$(docker run --detach --rm \
  --name "$name" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=hc_security_test \
  --env POSTGRES_PASSWORD=fixture-only-local-test \
  --env POSTGRES_DB=hc_security_test \
  postgres:18)"

if [[ ! "$CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Could not verify the disposable Docker container ID." >&2
  exit 3
fi
port="$(docker port "$CONTAINER_ID" 5432/tcp | sed -n 's/^127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' | head -n 1)"
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
  echo "Could not verify loopback-only PostgreSQL port. Refusing to connect." >&2
  exit 3
fi

ready=0
for attempt in $(seq 1 50); do
  if docker exec "$CONTAINER_ID" pg_isready -q \
    -U hc_security_test -d hc_security_test; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Disposable PostgreSQL failed to initialize. No production DB touched." >&2
  exit 3
fi

# Unset inherited database/provider credentials. Only a validated localhost
# fixture URL is available to the subprocess, and no vendor network calls run.
echo "Running status transition tests against localhost PostgreSQL ONLY."
env -u DATABASE_URL -u PGSSL -u PGSSLMODE -u PGHOST -u PGPORT \
  -u PGUSER -u PGPASSWORD -u PGDATABASE -u PGSERVICE \
  -u LIGHTSPEED_TOKEN -u LIGHTSPEED_DOMAIN \
  -u DISCORD_TOKEN -u DISCORD_BOT_TOKEN -u TIME_CLOCK_ADMIN_SECRET \
  -u TIMECLOCK_ADMIN_SECRET \
  HC_SECURITY_DISPOSABLE_DB_URL="postgresql://hc_security_test:fixture-only-local-test@127.0.0.1:$port/hc_security_test" \
  node --test --test-concurrency=1 tests/core-operations-status-postgres-isolated.test.mjs

echo "Disposable database verification completed. Temporary container will be removed."
