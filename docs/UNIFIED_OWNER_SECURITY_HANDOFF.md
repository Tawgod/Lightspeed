# Unified first Owner security — integration acceptance

**Last verified 2026-11-10 — In Development, combined automated tests PASSED, not deployed.**

## Source of truth
- `Tawgod/Lightspeed:integration/owner-security-unified-20261110`, draft PR #56; base `feature/owner-passkey-totp-enrollment-20261110` (draft PR #55).
- Consolidated source stack: first Owner passkey #50 → operator-selected one-time activation #53 → protected browser #54 → same-account Owner Authenticator #55; combined with multi-Owner permission implementation from #52, itself based on Admin #34.
- The first Owner is explicitly operator-selected from the **existing, active canonical Timeclock account**; no new employee account and no existing PIN change. A private one-time activation plus verified device passkey are required to commission the first Owner.
- Once commissioned, an active Owner's fresh passkey permits their own encrypted Google Authenticator enrollment through the existing employee security request, QR and six-digit confirmation. Later Owners are appointed by a strongly authenticated active Owner using the existing Admin permission service.

## Reconciliation decisions
- Removed the incompatible `hc_admin_single_active_owner` draft database index through the revised `db/hc_admin_delegations.sql`, permitting multiple active Owners.
- Kept strict **initial Owner exclusivity**: the first Owner activation/registration is denied once *any* Owner record exists (including inactive historical Owner records), preventing a second bootstrap.
- Additional Owner appointment is an entirely separate backend route/service operation, requiring a strongly verified current active Owner, canonical active Timeclock target, reason and append-only audit. Refuses self-appointment, role claims, inactive target recovery, TOTP-only elevation and final-Owner removal.
- Active Owners inherit recognized tool permission grants but never bypass independent strong authentication or operation-specific write authorization.
- Earlier experimental independent Ed25519 attestation components are still present in the inherited development history but are **not wired to the simplified first Owner route**. Do not deploy multiple competing bootstrap methods.
- Reuses the existing staff TOTP subsystem and Security Settings browser UI, not a duplicate security database.

## Tests
- [Unified security CI 42857873844](https://github.com/Tawgod/Lightspeed/actions/runs/42857873844) **SUCCESS: 27 tests, 27 pass, 0 fail, 0 skipped** across 12 test files. Real disposable PostgreSQL 16 used for Owner token consumption/rollback, multi-Owner grants and Authenticator confirmation; HTTP security tests cover owner activation and admin route.
- [Employee Admin integration contract 42857873617](https://github.com/Tawgod/Lightspeed/actions/runs/42857873617) **SUCCESS** for the same feature commit `b5308cb89d87f986d102e41badd8b9f335ef7cfc`.
- WebAuthn completion in the database tests uses a simulated verifier; actual device attestation is **not** established, and the current setup factory deliberately refuses production mode. No Codespace or real browser run was performed.

## Required pre-release gates
1. Confirm that the single new unified workflow is required and review branch protection, PR ancestry and earlier unfinished drafts before any merge.
2. Separate trusted deployment operator's activation issuance privileges from runtime DB role; require a one-use 32-byte random secret, digest-only storage and <=15min window. Never send activation, PIN, QR seed, TOTP or passkey proof to ChatGPT.
3. Obtain an authorized read-only lookup of the **actual** Timeclock employee ID (not synthetic staging 901), and confirm signing/session authenticity, canonical employee active status and revocation.
4. Review secure HTTPS origin, browser CSRF/session binding/proxy, privacy, rate limiting and WebAuthn RP ID. Test true physical device WebAuthn registration and authentication.
5. Review all additive PostgreSQL migrations, backup and rollback, security logs, key custody/recovery, proper TOTP encryption and signing secrets. Verify TOTP QR, six-digit confirmation, replay/expiry and recovery with a real device in controlled staging.
6. Replace or reconfigure **test-only** factory guard only through a separate approved deployment change; mount the verified router, Timeclock auth and factor services in a purpose-built production-safe service, never in the old synthetic staging login.
7. Add/verify the Admin page's multiple-Owner management UI and validate full-access Owner grants across shared Lightspeed tools. Obtain explicit permission before migrating production DB, mounting live service, changing employee role or deploying.

**Deployed:** Nothing. No production/Timeclock/Railway/extension changes, and no real Owner credential or account activation performed.
