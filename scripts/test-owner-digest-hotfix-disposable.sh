#!/usr/bin/env bash
# Focused hotfix tests against throwaway PostgreSQL 18 ONLY.
# Does not read Railway variables, access production, or deploy.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
[[ "${HC_TEST_DATABASE_URL:-}" == "" ]] || {
  echo "REFUSED: HC_TEST_DATABASE_URL must not be preconfigured"; exit 2;
}
command -v docker >/dev/null || { echo 'Docker not found in this Codespace'; exit 2; }
command -v node >/dev/null || { echo 'Node.js not found'; exit 2; }
[[ -d node_modules/pg ]] || { echo 'Dependencies missing: run npm install --ignore-scripts --no-audit --no-fund'; exit 2; }
CONTAINER="hc-owner-digest-test-$$"
cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_USER=hc_test -e POSTGRES_PASSWORD=hc_test \
  -e POSTGRES_DB=hc_test -p 127.0.0.1:55439:5432 postgres:18 >/dev/null
ready=false
for attempt in $(seq 1 40); do
 if docker exec "$CONTAINER" pg_isready -q -U hc_test -d hc_test &&
    (echo > /dev/tcp/127.0.0.1/55439) 2>/dev/null; then
   ready=true
   break
 fi
 sleep 1
done
[[ "$ready" == true ]] || { echo 'Disposable PostgreSQL 18 failed readiness'; exit 1; }
# Schema names are disposable and the test refuses a database URL lacking hc_test.
export HC_TEST_DATABASE_URL='postgres://hc_test:hc_test@127.0.0.1:55439/hc_test'
node --check services/security/operatorFirstOwnerPasskeyCandidate.js
node --check tests/operator-first-owner-postgres.test.mjs
node --test --test-concurrency=1 \
  tests/operator-first-owner-postgres.test.mjs \
  tests/owner-operator-activation-cli.test.mjs \
  tests/first-owner-activation-router.test.mjs
echo 'HC_OWNER_DIGEST_HOTFIX_TESTS_PASSED=true'
