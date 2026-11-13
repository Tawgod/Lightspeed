#!/usr/bin/env bash
# Isolated, local Codespaces test only. Never connects to Railway, production,
# or the existing Owner staging database; never uses GitHub Actions.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

for cmd in docker node; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing $cmd. Run this in a Codespace with Docker and Node installed." >&2
    exit 1
  }
done
docker info >/dev/null 2>&1 || {
  echo "Docker daemon unavailable in this Codespace." >&2
  exit 1
}
if [[ ! -d node_modules/pg ]]; then
  echo "Node dependencies are not installed. Run npm ci in the Codespace." >&2
  exit 1
fi

name="hc-owner-recovery-disposable-$$"
secret="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
echo "Starting a disposable PostgreSQL 18 container (Codespace only)."
docker run --detach --rm --name "$name" \
  --env POSTGRES_PASSWORD="$secret" --env POSTGRES_DB=hc_test \
  --publish 127.0.0.1::5432 postgres:18 >/dev/null

for n in $(seq 1 45); do
  if docker exec "$name" pg_isready -U postgres -d hc_test >/dev/null 2>&1; then
    break
  fi
  if [[ "$n" -eq 45 ]]; then
    echo "Disposable PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 1
done

hostport="$(docker port "$name" 5432/tcp)"
if [[ ! "$hostport" =~ ^127[.]0[.]0[.]1:[0-9]+$ ]]; then
  echo "Unsafe Docker bind address, refusing test." >&2
  exit 1
fi
port="${hostport##*:}"

# The test itself enforces localhost /hc_test, refuses an existing staging DB,
# creates a throwaway hc_owner_stage_test inside this disposable PG container,
# verifies privileges/atomicity, then drops it. Container is always removed.
echo "Testing private activation CLI and one-time DB recovery."
HC_OWNER_RECOVERY_DB_TEST=1 \
HC_TEST_DATABASE_URL="postgresql://postgres:${secret}@127.0.0.1:${port}/hc_test" \
  node --test tests/owner-operator-activation-cli.test.mjs \
    tests/owner-expired-activation-recovery.test.mjs

echo "Disposable Owner recovery tests passed. PostgreSQL container will be removed."
