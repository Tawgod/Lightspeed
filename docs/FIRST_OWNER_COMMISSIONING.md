# First real Owner commissioning — controlled activation runbook

**2026-11-09 — Development only. No production identity change or approval issued.**

## Purpose
Connect the *existing* canonical Timeclock employee to an independently established first Owner identity, register that employee's first **verified WebAuthn passkey** and then allow separately approved Google Authenticator enrollment. No PIN reset, test employee 901 migration, role inferred from Scanner/Discord, or self-service Owner promotion.

## Authority and trust ceremony (requires business-owner approval and independent proof)
1. Privately verify the human business owner and a recovery contact/authorized independent commissioning operator using an out-of-band, auditable business process. This process is not implemented by Hobby Corner's PIN, Discord or staging account.
2. Have the owner sign in via the reviewed HTTPS Timeclock employee gateway. Confirm the canonical Timeclock employee ID via the server-to-server employee authorization route. Never paste PIN/session/OTP/passkey evidence into a chat, ticket or code repository.
3. An **independent operator** (not the target employee, not synthetic 901) verifies the owner's business authority by approved evidence and records only an irreversible SHA-256 evidence digest and a non-secret operator reference, along with an approval UUID and target canonical employee ID. The identity-verification provider and its terms, proof-of-control policy, operator authorization and recovery must be independently reviewed.
4. Only a separately privileged, manually controlled operator may insert the 30-minute, one-time `hc_owner_commissioning_authorizations` record. App/runtime DB role must have **no INSERT, DELETE or approval editing ability**. Permission audit, network access, backup and rotation must be reviewed before use. Merely holding the Timeclock PIN must never create this record.
5. The employee registers a real passkey on the same reviewed HTTPS origin. Existing `staffPasskeysPostgres.finishRegistration` validates WebAuthn challenge, origin, RP ID and user verification. Only after that, inside its same DB transaction, `createFirstOwnerCommissioning().commitRegistrationGrant` locks the independently issued authorization, rechecks canonical signed employee and independent evidence, ensures no Owner already exists, consumes the authorization, inserts the Owner principal and appends an audit event. Any error rolls back the whole passkey/Owner operation.
6. Register a second recoverable passkey/security key and verify Owner sign-in/logout, active Timeclock recheck, lockout and recovery. Do not use only one phone or allow PIN-only emergency fallback.
7. Once a real Owner is independently commissioned and strong factor verified, process the *new* primary-account Google Authenticator request through the durable approval system. Require a separately authorized approver for live TOTP enrollment; the Owner must not automatically approve their own enrollment.
8. Confirm fresh TOTP QR works in a private browser, six-digit code is accepted once, replay/expired/revoked/wrong-employee codes fail, and no seed leaks into logs, external QR services or client caches.

## Technical review before deployment
- Reconcile shared services PRs #32/#33/#38 and Admin PR #34 with primary identity/security PRs #39–#44; verify integration ancestry, guards and migration ordering.
- Review `db/hc_admin_delegations.sql`, `db/hc_owner_commissioning.sql`, passkey, throttle, audit, enrollment and TOTP schemas in disposable PostgreSQL. **No migration is authorized by this runbook.**
- Verify independent `verifySignedCanonicalEmployee` and `verifyIndependentEvidence` implementations. Reject mock callbacks, test secrets, claims in request JSON/headers and any producer that accepts a PIN as business-owner proof.
- Review database role separation, HTTPS origin and CSRF/proxy settings, edge protection, concurrency/race handling, atomic rollback, privacy of evidence, recovery ownership and operator audit.
- Deploy only a separately approved isolated **real-Timeclock read-only verification** step before permitting the strong-factor commissioning ceremony. Synthetic staging must remain isolated from real employee data.
- Obtain explicit deployment/production DB change authorization and perform read-only, device and recovery acceptance before exposing live enrollment.

## Implemented contract vs unfinished
**Implemented / unit-tested:** one-use authorization schema proposal; passkey transaction-hook consumer, independent evidence callback and canonical-ID constraints; deny on existing Owner, expired/consumed authorization or failed evidence. Candidate is **not wired into a running passkey instance**.

**Not implemented:** independently authorized operator/verification provider, safe evidence issuance, production DB role grants/migrations, approved real Timeclock self-verification environment, actual Owner consent/recovery procedure, passkey commissioning browser and live Google Authenticator setup.

**Stop condition:** never issue or consume a commissioning authorization, or represent the real employee as Owner, until independent human verification, trusted backend adapters, secure origin, recovery plan, and explicit rollout approval are completed.
