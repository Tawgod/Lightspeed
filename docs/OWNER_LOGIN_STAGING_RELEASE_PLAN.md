# Owner login integration — isolated staging release plan

**2026-11-10 — Preparation only. Not deployed.** This plan coordinates the two
draft PRs required to attach an Owner passkey and Google Authenticator to
the operator-selected **existing** Timeclock employee account without replacing
its PIN. No production Owner has been appointed.

## Source and independently tested prerequisites

- Production Timeclock candidate: [PR #59](https://github.com/Tawgod/Lightspeed/pull/59), based on `integration/hobby-corner-consolidation`. Default-disabled dedicated `/api/timeclock/integrations/owner-staging/{verify-pin,authorize}`, independent service secret and durable per-account throttle. Existing Scanner APIs are left intact. Unapplied `timeclock/db/hc_owner_stage_login_limits.sql`.
- Staging login candidate: [PR #60](https://github.com/Tawgod/Lightspeed/pull/60), stacked on [PR #58](https://github.com/Tawgod/Lightspeed/pull/58). Owner staging client and private operator activation issuer opt in to the new dedicated header/paths. The default Scanner adapter retains its existing behavior.
- Isolated staging grants: `db/hc_owner_staging_privilege_groups.sql`. Creates **NOLOGIN** runtime/operator privilege groups only; makes no public account, connection secret or production role. Apply out of band only after all isolated staging schemas have been reviewed. Tested using disposable PostgreSQL 16 and 18; no actual Railway migration performed.
- Existing Railway staging resources: project `HC Owner Security Staging` (`2b350cde-048e-4402-bd92-4e8ba6c9f877`), environment `test` (`db9d6e8c-bb03-441b-a154-80c11536dfbb`), staged `owner-security-staging` app and PostgreSQL 18 template, **no live deployments, no domain**. The whole patch is staged; applying it together before app secrets/privileges are configured will produce a non-ready application. Never commit the patch incidentally.

## Gate A — production Timeclock additive code (requires separate explicit approval)

1. Compare #59 with the current integration branch and review default-deny behavior, Timeclock/Scanner regression, credential/HMAC independence, socket-peer trust and reverse-proxy/abuse resistance. Re-run required CI on the exact approved head.
2. Confirm a tested backup/restore of Timeclock PostgreSQL before any production SQL. Review and separately authorize the additive `hc_owner_stage_login_limits` schema. **Do not apply migration from the app automatically.**
3. Obtain explicit approval to merge and deploy #59 on Railway production Timeclock. At first rollout leave `OWNER_STAGING_IDENTITY_ENABLED` false and never set employee ID from the browser.
4. Verify Timeclock and Scanner production paths remain healthy; if not, disable Owner-specific route and use the approved Railway rollback. Do not change or rotate the existing four-digit PIN, `SCANNER_SERVICE_SECRET`, or `TIMECLOCK_PIN_PEPPER`.
5. Privately verify the exact active canonical Timeclock Owner employee ID. Generate an independent `OWNER_STAGING_SERVICE_SECRET` and `OWNER_STAGING_THROTTLE_SECRET` in the approved secret manager; never expose either in chat, logs, PRs, or browser. Match the Owner app's `HC_OWNER_TIMECLOCK_SERVICE_SECRET` to the dedicated Timeclock secret via protected Railway config. A later separately approved enable step may set `OWNER_STAGING_EMPLOYEE_ID` and `OWNER_STAGING_IDENTITY_ENABLED=true` only after all other gates.

## Gate B — isolated staging database and app (requires separate explicit approval)

1. Deploy only to the dedicated staging project after reviewing its full pending patch. Review PostgreSQL 18 template/volume version and private networking. Take a backup before migrations; schema test success is not a live backup.
2. Under an independent operator/migration database identity create only `hc_owner_stage_test` and the reviewed schemas, then apply `db/hc_owner_staging_privilege_groups.sql` **only in that isolated DB**. Create two independent LOGIN roles and passwords privately, grant exactly one NOLOGIN group to each; do **not** use database superuser as app runtime. Set operator credential outside the public app and keep it out of Railway's app environment.
3. Configure staging app through Railway protected secrets: `HC_OWNER_STAGING_DATABASE_URL` pointing to the limited runtime role and exactly `hc_owner_stage_test`, `HC_OWNER_TIMECLOCK_SERVICE_SECRET`, `HC_OWNER_SESSION_SECRET`, `HC_OWNER_THROTTLE_SECRET`, `HC_OWNER_PASSKEY_SIGNING_SECRET`, `HC_OWNER_APPROVAL_HMAC_SECRET`, `HC_OWNER_MFA_SESSION_SECRET`, independently generated base64 32-byte `HC_OWNER_TOTP_ENCRYPTION_KEY`. All distinct and never reused from production.
4. Assign a NEW trusted HTTPS hostname to the staging service, and set `HC_OWNER_STAGING_ORIGIN` to its exact URL and `HC_OWNER_STAGING_RPID` to its hostname. Configure exact privately verified `HC_OWNER_TIMECLOCK_EMPLOYEE_ID` and the approved `HC_OWNER_TIMECLOCK_ORIGIN`. Keep synthetic login/pin-setup flags false.
5. Allow `HC_OWNER_STAGING_ENABLED=true` only when app startup preflight verifies schema, role privilege separation, origin and all secret requirements. The app must stay fail-closed otherwise. Confirm `/health` only after the app is genuinely ready. Do not expose credentials or activation details in health/logging.

## Gate C — private first Owner staging acceptance (requires the owner present)

- Operator directly controls an **interactive private terminal** with the distinct operator DB login and source credentials. Use the already reviewed `scripts/issue-owner-stage-activation.mjs --issue-staging-owner` only after personally confirming the exact canonical Timeclock employee ID. The approval is global single-use, 10-minute expiry; never run through AI, CI or captured remote logs.
- On trusted staging HTTPS, owner signs in with existing Timeclock PIN, privately consumes the one-use approval, registers a real passkey, proves a fresh passkey authentication, and enrolls Google Authenticator on the **same** employee ID with a scanned QR and confirmed six-digit code.
- Test reauthorization/revocation, replay denial, cross-account PIN rejection, expiration, private factor recovery, device compatibility and real reverse-proxy headers. Do not promote the synthetic staging employee `901` or treat CI's mocked WebAuthn as real device acceptance.
- No production Owner grant or production factor commissioning follows automatically. Request independent signed-off production rollout and recovery plan after staging acceptance.

## Stop and rollback rules

- Any missing token, wrong employee ID, overprivileged app DB role, unsafe origin, incorrect RP ID or unavailable Timeclock verifier must block startup, not fall back to synthetic identity or shared Scanner secret.
- Keep the dedicated Timeclock endpoint default-disabled. If abuse, lockout, incorrect mapping or security anomalies appear, disable `OWNER_STAGING_IDENTITY_ENABLED` first, rotate only the dedicated secrets if needed, and review logs without exposing PIN/OTP.
- Do not apply the stage resources, production DB migration, production code merge, credential activation, live Owner appointment, Chrome extension release or PIN rotation from this runbook without their separate explicit authorization.

## Status accounting

- Implemented: PR #59 and PR #60 candidate code; staged DB privileges script.
- Tested: automated CI incl. disposable PostgreSQL 16/18, Timeclock and Scanner/Owner contract tests (confirm exact final heads at release).
- Deployed: none. First real Owner login: unavailable.
