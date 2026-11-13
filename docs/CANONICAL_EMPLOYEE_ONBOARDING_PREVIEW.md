# Canonical Timeclock employee self-discovery — isolated setup candidate

**Status: In Development. Not mounted or deployed for real employees.** Prepared November 12, 2026.

## Purpose and reuse

This source-only candidate follows the operator-verified isolated employee read pilot, but must never reuse its synthetic employee 901, PIN, signed session, operator token, or expiring grant. It builds on the existing Timeclock Scanner identity client, shared signed staff gateway, persistent PostgreSQL throttle, primary Timeclock identity discovery route, and separately commissioned Owner check. It creates no new employee database or Owner role.

## Added source and admission

- services/staffAuthGateway.js now optionally requires a numeric employeeId selector along with the normal 4-digit PIN. The public selector is used to reserve a per-employee and server-observed-IP durable throttle **before** calling Timeclock. The returned Timeclock PIN identity MUST match the selector before issuing any signed session. Legacy scanner/Owner and synthetic callers do not enable this selector automatically.
- services/security/canonicalEmployeeDiscoveryPreview.js composes the above existing clients without mounting it in server.js. The backend only recognizes a canonical active Timeclock employee, rejects ID 901, and rechecks current canonical employee status on signed requests. Scanner role/canApprove metadata are stripped; they do not appoint an Owner.
- A trusted read-only checkOwnerAssignment callback from an independent Owner authority is mandatory. Missing/failed lookup denies or reports unavailable, never grants or silently assumes Owner.
- Future factory routes only: GET /health, POST and GET /HobbyCorner/api/staff-auth/session and GET /HobbyCorner/api/primary/self. The self endpoint reports exact current employee identity readiness with enrollmentAuthorized:false. No device enrollment, Admin, Special Orders, Lightspeed, Discord, permission writer, real customer data or TOTP QR.
- POST sign-in requires exact configured Origin and rejects explicit cross-site fetch metadata. The service does not trust browser X-Forwarded-For.
- Environment must be independent isolated TEST, a reviewed Railway HTTPS origin, approved backend-only private/HTTPS Timeclock origin, unique server-held 32+-byte secrets, base path /HobbyCorner, and explicit kill switches for synthetic PIN, pilot bootstrap, Owner, business writes, Scanner and vendor integration. No administrator DATABASE_URL may be present.
- A restricted PostgreSQL role must have each of SELECT, INSERT and UPDATE on the durable login throttle, but not CREATE schema, DELETE/TRUNCATE throttle rows, or access to Owner/passkey tables. Production/bootstrap database identities fail closed.

## Test evidence

tests/canonical-employee-onboarding-preview-postgres.test.mjs exercises the actual shared HTTP/signed-session modules against a fake HTTP Timeclock service and disposable PostgreSQL 16 with a limited login role. It tests rejected cross-site/mismatched IDs, an active canonical employee with independent Owner=false, non-transfer of the Timeclock Owner role, rejected missing/revoked/offline credentials, and absent business/factor/Admin endpoints. Tests use synthetic fixture values only, never a real PIN, Timeclock secret or customer record. The existing combined foundation CI workflow was updated (no new workflow). Final CI run is recorded in the PR and project handoff after verification.

## Real employee setup gates still required

1. Resolve the existing HC Owner Security Staging project's 55 pending staged changes without committing them casually; it is NOT a commissioned real Owner identity. Do not reuse the isolated synthetic pilot, PR63 staging, or locked Owner preview.
2. Independently review the real Timeclock integration origin, backend service secret, active/inactive employee contract, proxy IP trust and PIN rate limits. No real employee PIN/secret is shared through chat, GitHub, Discord or logs.
3. Audit the existing unified Owner commissioning/passkey branch and provision an independently confirmed real Owner approver and read-only Owner grant adapter. Neither Scanner canApprove nor a Timeclock PIN proves Owner authority.
4. Explicitly approve any new isolated real-employee staging environment and least-privilege database before deployment. The code is not a deployable entrypoint and does not request real employee credentials today.
5. Obtain separate approvals for actual Owner credential enrollment, factor QR, 38 exact tool grants, real business data, Timcorp gateway, Chrome extension and production changes.

**System:** Employee Administration / Timeclock. **Implemented:** candidate factory and tests. **Tested:** CI evidence. **Deployed:** NO. **Real employee enabled:** NO.
