# Owner Security — Fast Finish / Resume Here (Nov 13, 2026)

**Scope:** isolated Owner staging only. No production Timeclock/Lightspeed, gateway, extension or existing permissions are changed. Draft PR [#75](https://github.com/Tawgod/Lightspeed/pull/75) remains unmerged.

## Current verified milestones

1. Operator-provided Codespaces URL probes passed 5/5: health ready, enrollment page/client HTTP 200, unauthorized cross-site and missing-activation POST rejected 403.
2. Operator-provided disposable PostgreSQL 18 recovery tests passed **4/4** on source commit `2b716f7564194e1e9a632f844aefbc0154c8b63c`, including least-privilege definer owner and immutable recovery audit.
3. Independent Railway read-only inventory: isolated project `5b46096d-3178-47ec-ba88-d5037696346a` / environment `staging`; Owner DB service **Postgres-x8Ui**, id `5c4498e4-cffb-4224-916a-af57391d1cd9`, app **hc-owner-staging** pinned at `60cefaf71d7b737753728f95f8474df17e99912c`. No staged Railway changes.
4. Manual backup search: Google Drive [HC Backups → Railway → Railway backups](https://drive.google.com/drive/folders/1FClPbgzdZljQzjqENdoK88omJC000Zom) contains encrypted `hc-production` files, **not a verified Owner staging backup**. Do not open `Backup password.rtf` or transfer its contents. User reports additional USB backups (not verified).

## Step 1 — Test remote Owner DB access (read only)

In Codespaces `/workspaces/Lightspeed-owner-migration` on branch
`feature/owner-expired-activation-recovery-20261113`:

```bash
railway ssh --project 5b46096d-3178-47ec-ba88-d5037696346a \
 --environment staging --service Postgres-x8Ui \
 -- sh -lc 'psql -U postgres -d hc_owner_stage_test -tAc "SELECT current_database(), current_user"'
```

Expected database `hc_owner_stage_test`, role `postgres`. If CLI/SSH fails, stop here and report sanitized error; never paste DB URL/password.

## Step 2 — Private backup and disposable restore

New `scripts/backup-owner-staging-verified.sh` is **an operator-run backup helper, not yet end-to-end executed**. It only targets project/env/service/database IDs above. Railway CLI SSH creates a custom-format `pg_dump` in remote service `/tmp`; Railway CLI `service files download` copies it into Codespaces private directory; `age -p` encrypts the backup with an interactively entered passphrase; separate disposable PostgreSQL 18 Docker container restores the plaintext dump to a `restorecheck` DB and verifies relevant table presence. On exit the helper deletes transient plaintext; encrypted `.dump.age` remains at `~/hc-owner-private-backups`. Container and temporary remote dump are removed. Does not need or change production DB, does not open a public TCP proxy.

```bash
cd /workspaces/Lightspeed-owner-migration
git pull --ff-only
bash -n scripts/backup-owner-staging-verified.sh
command -v age || echo "Install age in this Codespace before running"
bash scripts/backup-owner-staging-verified.sh --backup-owner-staging-only
```

If `age` is unavailable, install it in Codespaces from an approved package source before running; never put plaintext dump in Drive. The helper may require Railway SSH key authentication. **Any error is a blocker:** do not infer a backup from file existence alone; look for `BACKUP_AND_RESTORE_VERIFIED=true`.

Immediately save the **encrypted** output file externally (VS Code Codespaces Explorer → download; then private Google Drive Railway backups folder and/or USB). Keep the passphrase **separately** in a password manager, never in chat, repo, logs or beside the encrypted archive. The script itself cannot upload Codespaces files to the user's Google Drive. Confirm it was actually uploaded and a copy remains accessible.

## Step 2b — Resume an already encrypted backup if the restore step fails

On November 13 the operator's first remote dump succeeded but the CLI download
initially refused unsupported flags. That was corrected by an isolated Railway
CLI link. A second run then confirmed the correct remote database, downloaded
`hc-owner-stage-20261113T204750Z-64857.dump`, and completed the `age`
encryption and decrypt/hash roundtrip, but Docker refused a malformed
container name `hc-owner-restore-check-# Owner Security — Fast Finish / Resume Here (Nov 13, 2026)

**Scope:** isolated Owner staging only. No production Timeclock/Lightspeed, gateway, extension or existing permissions are changed. Draft PR [#75](https://github.com/Tawgod/Lightspeed/pull/75) remains unmerged.

## Current verified milestones

1. Operator-provided Codespaces URL probes passed 5/5: health ready, enrollment page/client HTTP 200, unauthorized cross-site and missing-activation POST rejected 403.
2. Operator-provided disposable PostgreSQL 18 recovery tests passed **4/4** on source commit `2b716f7564194e1e9a632f844aefbc0154c8b63c`, including least-privilege definer owner and immutable recovery audit.
3. Independent Railway read-only inventory: isolated project `5b46096d-3178-47ec-ba88-d5037696346a` / environment `staging`; Owner DB service **Postgres-x8Ui**, id `5c4498e4-cffb-4224-916a-af57391d1cd9`, app **hc-owner-staging** pinned at `60cefaf71d7b737753728f95f8474df17e99912c`. No staged Railway changes.
4. Manual backup search: Google Drive [HC Backups → Railway → Railway backups](https://drive.google.com/drive/folders/1FClPbgzdZljQzjqENdoK88omJC000Zom) contains encrypted `hc-production` files, **not a verified Owner staging backup**. Do not open `Backup password.rtf` or transfer its contents. User reports additional USB backups (not verified).

## Step 1 — Test remote Owner DB access (read only)

In Codespaces `/workspaces/Lightspeed-owner-migration` on branch
`feature/owner-expired-activation-recovery-20261113`:

```bash
railway ssh --project 5b46096d-3178-47ec-ba88-d5037696346a \
 --environment staging --service Postgres-x8Ui \
 -- sh -lc 'psql -U postgres -d hc_owner_stage_test -tAc "SELECT current_database(), current_user"'
```

Expected database `hc_owner_stage_test`, role `postgres`. If CLI/SSH fails, stop here and report sanitized error; never paste DB URL/password.

## Step 2 — Private backup and disposable restore

New `scripts/backup-owner-staging-verified.sh` is **an operator-run backup helper, not yet end-to-end executed**. It only targets project/env/service/database IDs above. Railway CLI SSH creates a custom-format `pg_dump` in remote service `/tmp`; Railway CLI `service files download` copies it into Codespaces private directory; `age -p` encrypts the backup with an interactively entered passphrase; separate disposable PostgreSQL 18 Docker container restores the plaintext dump to a `restorecheck` DB and verifies relevant table presence. On exit the helper deletes transient plaintext; encrypted `.dump.age` remains at `~/hc-owner-private-backups`. Container and temporary remote dump are removed. Does not need or change production DB, does not open a public TCP proxy.

```bash
cd /workspaces/Lightspeed-owner-migration
git pull --ff-only
bash -n scripts/backup-owner-staging-verified.sh
command -v age || echo "Install age in this Codespace before running"
bash scripts/backup-owner-staging-verified.sh --backup-owner-staging-only
```

If `age` is unavailable, install it in Codespaces from an approved package source before running; never put plaintext dump in Drive. The helper may require Railway SSH key authentication. **Any error is a blocker:** do not infer a backup from file existence alone; look for `BACKUP_AND_RESTORE_VERIFIED=true`.

Immediately save the **encrypted** output file externally (VS Code Codespaces Explorer → download; then private Google Drive Railway backups folder and/or USB). Keep the passphrase **separately** in a password manager, never in chat, repo, logs or beside the encrypted archive. The script itself cannot upload Codespaces files to the user's Google Drive. Confirm it was actually uploaded and a copy remains accessible.

. The full backup/restore
validation **did not complete**. The name was fixed on the draft branch
(commit `77a9c6e`), but there is no need to repeat the remote dump.

The existing encrypted file is expected at
`~/hc-owner-private-backups/hc-owner-stage-20261113T204750Z-64857.dump.age`.
`scripts/verify-owner-staging-archive.sh` is a separate, purely
local/isolated verification helper; no Railway connectivity, public ports,
or reusable plaintext is required. It decrypts the existing archive
**only into a disposable Docker PostgreSQL 18 container**, checks the
archive's embedded staging DB name, restores its full schema/data and checks
the historical expired/unused first-Owner employee-1 state without
printing the row. Deletes the container on exit. This helper has been
shell-syntax reviewed, **not yet successfully executed by the operator**.

```bash
cd /workspaces/Lightspeed-owner-migration
git pull --ff-only
bash -n scripts/verify-owner-staging-archive.sh
bash scripts/verify-owner-staging-archive.sh \
 --verify-encrypted-staging-dump \
 "$HOME/hc-owner-private-backups/hc-owner-stage-20261113T204750Z-64857.dump.age"
```

The operator enters the existing `age` backup passphrase locally. Require
`BACKUP_AND_RESTORE_VERIFIED=true`, then separately download the encrypted
archive from Codespaces to private Google Drive and/or USB. Do not paste the
passphrase, encrypted payload, employee data or database credentials to chat.
If verification fails, stop and report only the sanitized error. The
original backup helper also now uses a correct unique Docker container name.

## Step 3 — Migration approval gate

- Privately reconfirm Owner staging database `hc_owner_stage_test`, target employee 1, original authorization expired+unused, no first Owner, no passkey and no prior reissue, plus reviewed staging backup.
- Inspect `db/hc_owner_stage_expired_activation_recovery.sql` and restricted operator/runtime role grants. The migration adds an immutable reissue audit and one-shot recovery function owned by **NOLOGIN NOINHERIT** `hc_owner_stage_recovery_definer`, not postgres. It has passed disposable tests but is **NOT APPLIED** to Railway staging.
- Seek **explicit staging-only SQL migration approval** from the user. Never apply to other PostgreSQL service named `Postgres`, never deploy to production or merge PR #75.
- A privately authorized, privileged operator executes the reviewed SQL in a single isolated staging DB transaction, then performs restricted role readback. Do not give the public runtime role access to issue/renew credentials.

## Step 4 — One-time enrollment, only with phone/device ready

- Existing expired token cannot be reused. The private operator runs the reviewed script `scripts/issue-owner-stage-activation.mjs --reissue-expired-staging-owner`, with the separately provisioned operator DB and Timeclock service secrets, the exact canonical Timeclock employee ID **1**, interactive confirmation, and explicit additional recovery acknowledgement. Never use the web runtime DB or superuser for token issuance.
- The approved recovery can be performed **only once**, and the replacement activation expires after **10 minutes**. If enrollment cannot finish in that window, stop and plan a separate reviewed recovery rather than editing/deleting activation rows.
- In existing HTTPS staging domain `https://hc-owner-staging-staging.up.railway.app/owner-setup/`, complete the existing signed Timeclock + PIN session, register passkey on real user device, then enroll and verify Google Authenticator TOTP. Keep PIN, token, QR and secret private. Validate audit, sign-out/in, replay and cross-origin denial.
- This is *staging first Owner only*, not production Owner activation.

## One-line manager handoff

System Owner Security; implementation recovery PR #75 (draft, unmerged); testing 4/4 disposable PostgreSQL 18 PASS on hardened source; staging web health/negative checks PASS; deployed recovery NONE; next verify remote backup+restore and offsite encrypted file, approve isolated migration separately, perform private one-shot activation/passkey/TOTP; no production changes.
