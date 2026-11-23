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

# The postgres Docker image briefly starts an INITIALIZATION server and
# shuts it down before the final TCP server starts. An in-container pg_isready
# can report the temporary server as ready, causing intermittent connection
# termination while the DB test begins. Wait on the published TCP endpoint.
ready=0
for n in $(seq 1 60); do
  hostport="$(docker port "$name" 5432/tcp 2>/dev/null || true)"
  if [[ ! "$hostport" =~ ^127[.]0[.]0[.]1:[0-9]+$ ]]; then
    echo "Unsafe or unavailable Docker bind address, refusing test." >&2
    exit 1
  fi
  port="${hostport##*:}"
  testurl="postgresql://postgres:${secret}@127.0.0.1:${port}/hc_test"
  if HC_TEST_DATABASE_URL="$testurl" node --input-type=module -e '
      import pg from "pg";
      const client = new pg.Client({
        connectionString: process.env.HC_TEST_DATABASE_URL,
        connectionTimeoutMillis: 1200
      });
      try {
        await client.connect();
        const r = await client.query("SELECT current_database() AS db");
        if (r.rows[0]?.db !== "hc_test") process.exitCode = 1;
      } catch { process.exitCode = 1; }
      finally { await client.end().catch(() => {}); }
    ' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "Disposable PostgreSQL never accepted localhost TCP queries." >&2
  exit 1
fi

# A second connection, after initialization settles, catches an unexpected
# restart before destructive test-only setup begins.
sleep 2
if ! HC_TEST_DATABASE_URL="$testurl" node --input-type=module -e '
    import pg from "pg";
    const c = new pg.Client({
      connectionString: process.env.HC_TEST_DATABASE_URL,
      connectionTimeoutMillis: 1500
    });
    try {
      await c.connect();
      const r = await c.query("SELECT current_database() AS db");
      if (r.rows[0]?.db !== "hc_test") process.exitCode = 1;
    } catch { process.exitCode = 1; }
    finally { await c.end().catch(() => {}); }
  ' >/dev/null 2>&1; then
  echo "Disposable PostgreSQL TCP connection did not remain stable." >&2
  exit 1
fi

# The test itself enforces localhost /hc_test, refuses an existing staging DB,
# creates a throwaway hc_owner_stage_test inside this disposable PG container,
# verifies privileges/atomicity, then drops it. Container is always removed.
echo "Testing private activation CLI and one-time DB recovery."
HC_OWNER_RECOVERY_DB_TEST=1 \
HC_TEST_DATABASE_URL="postgresql://postgres:${secret}@127.0.0.1:${port}/hc_test" \
  node --test tests/owner-operator-activation-cli.test.mjs \
    tests/owner-expired-activation-recovery.test.mjs

echo "Disposable Owner recovery tests passed. PostgreSQL container will be removed."
