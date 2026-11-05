# Hobby Corner — first Owner passkey pilot release plan

**Status: In Development / Testing. No first Owner credential registered or WebAuthn pilot deployed as of 2026-11-05.**
This is for **Hobby Corner Integration Test / test / staff-security-staging** only. It cannot authorize production Timeclock accounts.

## Verified starting point

- Synthetic employee `901` test PIN creation and login were confirmed by the Owner; the Owner re-tested the same PIN successfully **after** the one-time PIN setup endpoint was retired.
- Live isolated security API, its private PostgreSQL and existing Consignment service are healthy. The pinned production-safe live service remains the **PIN-only** source `49c81533fe2c6bbeb3189319afc039299b95be96`, deployment `ce2d7703-5e14-413d-8e21-f57299733038`.
- There is an **uncommitted Railway staging patch** for a newer Lightspeed branch commit and factor flags. Inspect its current source SHA and flags immediately before approval. Never assume a previous patch description remains true: other development work has modified it.
- Do not enable Owner manager approvals, invitation issuance, TOTP enrollment or factor recovery during this pilot.

## Gate A — deploy the newer code in an inert state

Requires explicit authorization to deploy **test-only** changes.

1. Confirm the latest Phase 1 source commit has passed **Shared Lightspeed foundation**, **Scanner**, **Core Operations**, synthetic PIN retirement, bootstrap transaction, Owner passkey browser, and staging flag-matrix tests. Confirm Phase 2 is synchronized and separately label any unverified CI.
2. Inspect Railway's **exact pending patch**, commit SHA and target environment. Only `staff-security-staging` is allowed to change; no services should be deleted, and no duplicate Malcor Gateway process should be created.
3. Stage these literal values together before accepting any deployment:

```text
HC_STAGING_OWNER_PASSKEY_ENABLED=false
HC_STAGING_OWNER_BOOTSTRAP_ENABLED=false
HC_STAGING_OWNER_APPROVAL_ENABLED=false
HC_STAGING_OWNER_ENROLLMENT_ENABLED=false
HC_STAGING_PIN_STORE_MODE=database
HC_STAGING_PIN_SETUP_ENABLED=false
```

4. Accept the **test-only** patch only after approval. Verify Railway `/health`, Postgres and Consignment health; verify the old test PIN still signs in. Confirm `/test-owner-passkey`, `/staff-passkey/*`, `/staff-enrollment-invites/*`, and sensitive `/staff-security/*` endpoints remain unavailable. Do not reveal PINs in logs.

## Gate B — independently authorize the one-time credential ceremony

This is a **separate** test-only deployment approval, and the user must be ready at a passkey-capable device. Generate two unrelated cryptographically random secrets **outside GitHub/chat**. Use an approved local cryptographic generator or protected secrets manager, not a memorized password. Provision using Railway's protected staging variables:

```text
HC_STAGING_PASSKEY_SIGNING_SECRET=separate 32+ byte cryptographically random value
HC_STAGING_OWNER_BOOTSTRAP_KEY=independent 43-256 character base64url secret
HC_STAGING_OWNER_PASSKEY_ENABLED=true
HC_STAGING_OWNER_BOOTSTRAP_ENABLED=true
HC_STAGING_OWNER_APPROVAL_ENABLED=false
HC_STAGING_OWNER_ENROLLMENT_ENABLED=false
```

Keep the session and throttle secrets stable. The bootstrap key is a one-time *administrative* secret; access to Discord, the synthetic PIN, or a bot mention alone does not replace it. Never put it in a URL, commit, issue, screenshot, or chat. Provide it to the user privately through an authorized secrets interface.

The staging startup must validate environment/host/private database URL and migrate `hc_staff_passkeys`, `hc_staff_passkey_challenges`, and `hc_staging_owner_passkey_bootstrap` before opening health. The bootstrap row is inert until the first authorized registration-options call; that starts a **four-hour one-use window**, not the deployment itself.

### User's actual device test

1. Open `https://staff-security-staging-test.up.railway.app/test-owner-passkey` from the device where the passkey will be stored, ideally with a backup authenticator available. Check the page explicitly says **isolated test** and **register**.
2. Sign in with the **synthetic four-digit test PIN**, not a live Timeclock PIN.
3. Enter the **independent bootstrap key** on the HTTPS page only. Choose **Create Owner passkey** and complete the browser's native security-key / device verification.
4. The page clears the bootstrap key field before opening the prompt. A cancelled or denied ceremony requires re-entry; never copy it into chat for troubleshooting.
5. Choose **Verify Owner passkey** and complete a separate native authentication ceremony. The resulting proof is signed, bound to the current test session, and valid for no more than five minutes.
6. Record only success/failure and non-sensitive Railway deployment/test references. Do not record actual PIN, secret, public-key attestation payloads, token or credential ID in project docs.

A denied bootstrap must roll back both the public-key registration and its audit event. The one-use grant must not restart after expiry or consumption. If a test fails, **stop**; do not reset/recreate the row or delete any credential without a separate audited decision.

## Gate C — close bootstrap while preserving passkey verification

After a **user-verified successful registration and verification**, stage a third reviewed test-only deployment:

```text
HC_STAGING_OWNER_PASSKEY_ENABLED=true
HC_STAGING_OWNER_BOOTSTRAP_ENABLED=false
HC_STAGING_OWNER_BOOTSTRAP_KEY=
HC_STAGING_OWNER_APPROVAL_ENABLED=false
HC_STAGING_OWNER_ENROLLMENT_ENABLED=false
```

Keep `HC_STAGING_PASSKEY_SIGNING_SECRET` unchanged. The same `/test-owner-passkey` address must now serve a **verification-only** page, without a bootstrap field or visible registration action. Confirm the original test PIN and the registered passkey can still authenticate, while registration and every Authenticator/invitation endpoint remain blocked. Only afterward consider an **independently approved** manager step-up/enrollment milestone.

## Rollback and incident handling

- Before any passkey registration: disable `HC_STAGING_OWNER_PASSKEY_ENABLED` and `HC_STAGING_OWNER_BOOTSTRAP_ENABLED`, keep PIN database storage on, and revert to the known-good pinned PIN-only source if the newer service is unhealthy. Do not touch isolated Postgres rows.
- After registration: disabling the passkey flag blocks use but **does not delete** the stored credential. Never rotate the signing secret casually: it invalidates signed proofs and complicates audit continuity. Do not re-open bootstrap or issue a second secret as an informal reset.
- On an unexpected successful factor/invite API, wrong origin accepted, duplicate credential, unexpected database migration, or unapproved service change: stop rollout, disable every new flag, preserve logs without credentials, and review before continuing.
- Production Hobby Corner Lightspeed, Timeclock, the Chrome extension and both production/test Discord workers are outside this deployment's permitted scope.

## Verification and ownership

Source: `Tawgod/Lightspeed` Phase 1 PR #32 and stacked Phase 2 PR #33; live reality: Railway service/environment status. Record the passing commit, actual deployment ID, test device result, and post-deploy PIN/passkey acceptance in `Tawgod/Hobby-Corner:main/handoffs/hobby-bot-security-enrollment.md` and `CHANGELOG.md`.

**Remaining blockers:** explicitly authorized Gate A and Gate B test deployments, two privately provisioned independent secrets, real device WebAuthn registration and verification, a reviewed recovery plan, and separately authorized manager approval/TOTP integration. The dependency audit findings `adm-zip` and `xlsx` remain tracked under Hobby Corner issue #1.
