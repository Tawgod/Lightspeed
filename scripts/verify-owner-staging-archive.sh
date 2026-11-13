#!/usr/bin/env bash
# Private standalone VERIFY-ONLY drill for an encrypted Owner staging backup.
# Never connects to Railway, reads only local encrypted backup and disposable PG.
set -Eeuo pipefail
umask 077

if [[ $# -ne 2 || "$1" != '--verify-encrypted-staging-dump' ]]; then
  echo 'Usage: bash scripts/verify-owner-staging-archive.sh --verify-encrypted-staging-dump ~/hc-owner-private-backups/hc-owner-stage-YYYYMMDDTHHMMSSZ-PID.dump.age' >&2
  exit 2
fi

ARCHIVE="$2"
case "$ARCHIVE" in
  "$HOME"/hc-owner-private-backups/hc-owner-stage-????????T??????Z-[0-9]*.dump.age) ;;
  *) echo 'Refusing archive outside exact Owner staging backup directory.' >&2; exit 2 ;;
esac
if [[ ! -f "$ARCHIVE" || -L "$ARCHIVE" || ! -s "$ARCHIVE" ]]; then
  echo 'Encrypted staging archive missing or invalid.' >&2
  exit 1
fi
for cmd in age docker sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing $cmd" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'Docker is unavailable in Codespaces.' >&2; exit 1; }

CONTAINER="hc-owner-verify-$$"
RUNNING=0
cleanup() {
  if [[ "$RUNNING" -eq 1 ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Unpublished local PG: no Docker networking or Railway connections.
VERIFY_PW="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run --detach --rm --network none --name "$CONTAINER" \
  --env "POSTGRES_PASSWORD=$VERIFY_PW" --env POSTGRES_DB=restorecheck \
  postgres:18 >/dev/null
RUNNING=1
READY=0
for attempt in $(seq 1 45); do
  if docker exec "$CONTAINER" psql -U postgres -d restorecheck -tAc 'SELECT 1' 2>/dev/null | grep -qx 1; then
    READY=1
    break
  fi
  sleep 1
done
[[ "$READY" -eq 1 ]] || { echo 'Disposable PostgreSQL failed to start.' >&2; exit 1; }
sleep 2
docker exec "$CONTAINER" psql -U postgres -d restorecheck -tAc 'SELECT 1' | grep -qx 1

echo 'Decrypting the existing staging archive into a disposable container only.'
# Only the temporary container sees plaintext; its /tmp disappears on exit.
age -d "$ARCHIVE" | docker exec -i "$CONTAINER" sh -ec '
  umask 077
  cat > /tmp/owner-stage.dump
  test -s /tmp/owner-stage.dump
  pg_restore --list /tmp/owner-stage.dump > /tmp/owner-stage.toc
  grep -Eq "^;[[:space:]]*dbname:[[:space:]]*hc_owner_stage_test[[:space:]]*$" /tmp/owner-stage.toc
'

echo 'Restoring and checking only a disposable PostgreSQL 18 database.'
docker exec "$CONTAINER" pg_restore -U postgres --no-owner --no-acl \
  --exit-on-error -d restorecheck /tmp/owner-stage.dump

CHECK="$(docker exec "$CONTAINER" psql -U postgres -d restorecheck -tAc \
  "SELECT (to_regclass('public.hc_first_owner_activations') IS NOT NULL)::text || ':' || (to_regclass('public.hc_admin_principals') IS NOT NULL)::text")"
[[ "$CHECK" == 'true:true' ]] || { echo 'Required staging tables were not restored.' >&2; exit 1; }

# Confirm expected staging state without outputting any employee row.
IS_OWNER_STAGING="$(docker exec "$CONTAINER" psql -U postgres -d restorecheck -tAc \
  "SELECT (COUNT(*) = 1 AND bool_and(employee_id = 1) AND bool_and(consumed_at IS NULL) AND bool_and(expires_at < now()))::text FROM public.hc_first_owner_activations")"
[[ "$IS_OWNER_STAGING" == 'true' ]] || { echo 'Staging activation snapshot differs from expected expired unused employee-1 state.' >&2; exit 1; }

echo 'BACKUP_AND_RESTORE_VERIFIED=true'
echo "BACKUP_FILENAME=${ARCHIVE##*/}"
echo "BACKUP_BYTES=$(wc -c < "$ARCHIVE" | tr -d ' ')"
echo "BACKUP_SHA256=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
echo 'Keep encrypted archive offsite on private Drive/USB, and its passphrase separately in a password manager.'
