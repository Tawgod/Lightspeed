#!/usr/bin/env bash
# Safe isolated PostgreSQL 18 test: never connects to Railway.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
# The underlying runner refuses non-local database scopes and always removes
# its disposable PostgreSQL 18 Docker container on exit.
bash scripts/test-owner-recovery-disposable.sh
node --check scripts/issue-owner-stage-activation.mjs
node --check tests/owner-expired-activation-recovery.test.mjs
echo 'HC_OWNER_SECOND_RECOVERY_DISPOSABLE_TESTS_PASSED=true'
