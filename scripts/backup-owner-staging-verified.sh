#!/usr/bin/env bash
# Operator-run, NO database writes. Remote staging pg_dump -> private local
# working file -> isolated Docker restore -> age passphrase-encrypted archive.
# Requires Railway CLI SSH authentication & permission to download service files.
set -Eeuo pipefail
umask 077

PROJECT='5b46096d-3178-47ec-ba88-d5037696346a'
ENVIRONMENT='46b93c76-3085-4e76-a37d-90dfdd250dd2'
SERVICE='Postgres-x8Ui'
SERVICE_ID='5c4498e4-cffb-4224-916a-af57391d1cd9'
DATABASE='hc_owner_stage_test'

for program in railway docker age sha256sum; do
  if ! command -v "$program" >/dev/null 2>&1; then
    echo "Missing $program. Nothing was changed; install it in Codespaces first." >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo 'Docker not available in this Codespace.' >&2
  exit 1
fi

# No ambiguous default linked project or non-staging database.
if [[ "${1:-}" != '--backup-owner-staging-only' || $# -ne 1 ]]; then
  echo 'Usage: bash scripts/backup-owner-staging-verified.sh --backup-owner-staging-only' >&2
  exit 2
fi

DEST="${HOME}/hc-owner-private-backups"
mkdir -p "$DEST"
chmod 700 "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="hc-owner-stage-${STAMP}-$$"
REMOTE="/tmp/${NAME}.dump"
RAW="${DEST}/${NAME}.dump"
ENCRYPTED="${DEST}/${NAME}.dump.age"
CONTAINER="hc-owner-restore-check-$"
# This isolated directory owns only a temporary Railway CLI link. It must
# not modify the repository's own Railway context or deploy configuration.
LINK_DIR="$(mktemp -d)"
REMOTE_CREATED=0
DOCKER_STARTED=0

railway_command() {
  railway ssh --project "$PROJECT" --environment "$ENVIRONMENT" \
    --service "$SERVICE" -- "$@"
}

cleanup() {
  if [[ "$DOCKER_STARTED" -eq 1 ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  # The plaintext is never retained, even if a step fails. An encrypted copy
  # is intentionally retained for investigation if validation fails.
  rm -f -- "$RAW"
  if [[ "$REMOTE_CREATED" -eq 1 ]]; then
    railway_command sh -lc "rm -f -- '$REMOTE'" >/dev/null 2>&1 || true
  fi
  # Removes the scratch Railway link; no change to repository .railway.
  rm -rf -- "$LINK_DIR"
}
trap cleanup EXIT

# Refuse to overwrite any preexisting backup or partial backup.
if [[ -e "$RAW" || -e "$ENCRYPTED" ]]; then
  echo 'Private backup filename collision; run again later.' >&2
  exit 1
fi

printf '%s\n' '1/5: Checking exact remote database, then making a PRIVATE pg_dump.'
# All interpolated shell paths are derived from [a-zA-Z0-9_./-] only.
REMOTE_CREATED=1
railway_command sh -lc "
  set -eu
  umask 077
  db=\$(psql -U postgres -d '$DATABASE' -tAc 'SELECT current_database()' | tr -d '[:space:]')
  test \"\$db\" = '$DATABASE' || { echo WRONG_DATABASE >&2; exit 1; }
  pg_dump -U postgres -d '$DATABASE' -Fc -f '$REMOTE'
  test -s '$REMOTE'
  pg_restore --list '$REMOTE' >/dev/null
  echo HC_OWNER_STAGING_DUMP_READY
"

printf '%s\n' '2/5: Downloading backup directly from the authorized Railway service.'
# The installed Railway CLI rejects --project/--environment/--service when
# appended to "railway service files download". Link the *scratch directory*
# to the exact, separately verified service first; no source/deploy edits.
(
  cd "$LINK_DIR"
  railway link --project "$PROJECT" --environment "$ENVIRONMENT" \
    --service "$SERVICE_ID" --json >/dev/null
  railway service files download "$REMOTE" "$RAW"
)
[[ -s "$RAW" ]] || { echo 'Backup download empty or missing.' >&2; exit 1; }
chmod 600 "$RAW"

printf '%s\n' '3/5: Encrypting backup with age before further operations.'
age -p -o "$ENCRYPTED" "$RAW"
[[ -s "$ENCRYPTED" ]] || { echo 'Encrypted archive missing.' >&2; exit 1; }
ORIGINAL_SUM="$(sha256sum "$RAW" | cut -d' ' -f1)"
DECRYPTED_SUM="$(age -d "$ENCRYPTED" | sha256sum | cut -d' ' -f1)"
[[ "$ORIGINAL_SUM" == "$DECRYPTED_SUM" ]] || { echo 'Encryption roundtrip failed.' >&2; exit 1; }

printf '%s\n' '4/5: Restoring ONLY to a disposable local PostgreSQL 18 container.'
# The container uses a throwaway password and is not connected to Railway.
VERIFY_PW="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run --detach --rm --name "$CONTAINER" \
  --env "POSTGRES_PASSWORD=$VERIFY_PW" --env POSTGRES_DB=restorecheck \
  --mount "type=bind,source=$DEST,target=/backup,readonly" \
  postgres:18 >/dev/null
DOCKER_STARTED=1
READY=0
for attempt in $(seq 1 45); do
  if docker exec "$CONTAINER" psql -U postgres -d restorecheck -tAc 'SELECT 1' 2>/dev/null | grep -qx 1; then
    READY=1
    break
  fi
  sleep 1
done
[[ "$READY" -eq 1 ]] || { echo 'Disposable PostgreSQL did not start.' >&2; exit 1; }
sleep 2
docker exec "$CONTAINER" psql -U postgres -d restorecheck -tAc 'SELECT 1' | grep -qx 1
# No CREATE DATABASE and no connection to actual staging service.
docker exec "$CONTAINER" pg_restore -U postgres --no-owner --no-acl \
  --exit-on-error -d restorecheck "/backup/${NAME}.dump"
CHECK="$(docker exec "$CONTAINER" psql -U postgres -d restorecheck -tAc \
  "SELECT (to_regclass('public.hc_first_owner_activations') IS NOT NULL)::text || ':' || (to_regclass('public.hc_admin_principals') IS NOT NULL)::text")"
[[ "$CHECK" == 'true:true' ]] || { echo 'Restored staging tables missing.' >&2; exit 1; }
echo 'Disposable database restore validated.'

printf '%s\n' '5/5: Removing plaintext and remote temporary file.'
rm -f -- "$RAW"
railway_command sh -lc "rm -f -- '$REMOTE'"
REMOTE_CREATED=0

echo 'BACKUP_AND_RESTORE_VERIFIED=true'
echo "BACKUP_FILENAME=${NAME}.dump.age"
echo "BACKUP_BYTES=$(wc -c < "$ENCRYPTED" | tr -d ' ')"
echo "BACKUP_SHA256=$(sha256sum "$ENCRYPTED" | cut -d' ' -f1)"
echo "BACKUP_LOCATION=$ENCRYPTED"
echo 'NEXT: Download the encrypted .age file from Codespaces Files and upload it to your private Google Drive Railway backups folder and/or USB. Keep the age passphrase separately in a password manager. Never paste it here.'
