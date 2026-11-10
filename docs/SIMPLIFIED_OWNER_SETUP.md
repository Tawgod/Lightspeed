# Hobby Corner — Simplified Owner Account Setup (Revised Requirements)

**Decision:** The primary Owner is an **existing, real, active Timeclock employee**, not a separate administrative account and not the synthetic test Owner 901. An external business-ownership proofing provider is **not required** by the product workflow.

## Intended employee experience

1. **Initial administrator-controlled provisioning (once):** A trusted deploy operator selects the primary Owner's real canonical Timeclock employee record using a protected server-side configuration or audited commissioning process. The selected employee ID is never chosen by a browser field, PIN guess, Discord role, or the first person to visit a setup link. There must be no automatic Owner enrollment on an empty table.
2. **Existing Timeclock PIN stays unchanged:** The employee signs in through the existing Timeclock-backed session. The PIN remains a daily-use credential; it does not itself confer Owner permissions.
3. **First Owner passkey:** Register a device authenticator/security key through verified WebAuthn with user verification and the correct origin/RP ID. An explicitly provisioned one-time first-Owner authorization must be bound to the matching active Timeclock session and consumed atomically with the registered credential and audited Owner assignment. Do not let someone with only a stolen PIN enroll first Owner; use a private operator-controlled activation/approval gate, one-time token or equivalent.
4. **Google Authenticator:** After full Owner commissioning, the same Timeclock employee account may enroll TOTP using the existing PostgreSQL staff factor subsystem and current strong Owner passkey step-up; verify the code and issue recovery information over an authenticated UI, not chat. Do not change the PIN, create a separate staff identity, or copy from the synthetic test environment.
5. **Owner Admin menu:** A current active Owner with a fresh **passkey/security-key or approved strong MFA** can appoint and revoke *other* Owners on canonical active Timeclock employee records and manage scoped tool/admin permissions for other staff. A browser role label and a PIN-only session are insufficient for elevation.
6. **Recovery:** Prevent accidental removal of the final active Owner; require an independently protected administrative recovery procedure if every Owner loses all strong factors. Never fall back to the lowest employee privilege or the first new visitor.

## Current implementation, not live

- `db/hc_admin_delegations.sql` in this draft branch now supports multiple active Owners. `services/security/adminDelegationsPostgres.js` implements `changeOwnerRole`, and `routes/employeeAdmin.js` exposes an optional unmounted `POST /api/owners` route backed by it. Changes are audited; strong Owner proof and canonical target activity are required.
- Existing `services/security/adminOwnerCommissioning.js` already has a **deployment-selected exact employee ID** contract and rejects PIN-only setup, but expects an existing strong Owner passkey proof. It is **not** by itself a first-passkey registration path.
- [Draft PR #50](https://github.com/Tawgod/Lightspeed/pull/50) demonstrates atomic first Owner + WebAuthn registration with disposable PostgreSQL, but its **external signed-attestation requirement** no longer matches this simplified product decision. It must be reconciled/refactored **before** live setup, not silently deployed.
- Existing staff factor TOTP/passkey services and employee admin UI are implemented on development branches, not mounted as a production enrollment flow.

## Security controls worth retaining without third-party verification

- One-time, operator-selected **real Timeclock employee ID**, confirmed through the server's canonical employee reader
- Signed active employee session and strong-factor passkey registration
- Short, private, audit-logged activation window or one-time operator entitlement for initial assignment
- PostgreSQL atomicity, replay prevention, audit records, revocation and recovery
- HTTPS WebAuthn origin, CSRF/session protection and server-side Admin permission checks
- Production migrations/deployments only after explicit user authorization

## Current blockers

- User's actual canonical Timeclock employee record has **not** been safely selected/verified through a deployed authenticated UI; do not request PIN, OTP, recovery codes, or private identity documents in chat.
- One-time bootstrap issuance/first passkey registration and TOTP enrollment remain development-only; PR #50 has to be adapted to a local controlled initial setup.
- Multiple Owner role API is development-only and has no released Admin UI control or production route.
- Database migration compatibility, Codespaces/real browser proof, recovery, and production release approvals are pending.

## Next implementation sequence

1. Complete and verify multiple-Owner authorization + Admin route tests (this PR).
2. Refactor first Owner passkey commissioning to accept explicit operator-configured Timeclock employee ID and a secure, one-time operator activation (without external business identity verification).
3. Finish a guided Admin settings flow for passkey and Google Authenticator on the already logged-in employee, including recovery safeguards.
4. Accept a real passkey on a permitted staging domain and perform read-only canonical Timeclock binding verification, then request explicit authorization before any production migration or role assignment.
