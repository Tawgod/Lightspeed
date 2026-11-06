# Synthetic Owner authenticator approval policy (not deployed)

**Status:** In Development / Testing. Never activate without a separately approved isolated enrollment rollout.

The test-only policy in `staging/isolated-owner-approval-policy.js` is **not mounted** by the staging security API. It is a narrowly scoped reusable authorization dependency for a future composition using the existing `createStaffSecuritySubsystem` and `createPostgresStaffEnrollmentApprovals`, rather than a second TOTP implementation.

## Boundary
- Requires `NODE_ENV=test`, `HC_SECURITY_ENV=isolated-staging`, exact authorized test Discord owner/guild, fixed staging HTTPS origin, persisted PIN storage, closed one-time PIN setup and active first-Owner passkey.
- Requires a **separate explicit flag** `HC_STAGING_OWNER_APPROVAL_ENABLED=true`; enabling `HC_STAGING_OWNER_PASSKEY_ENABLED` alone must not permit authenticator enrollment.
- Accepts exactly synthetic employee ID `901` as both approver and employee **only in this isolated test** (no test staff/admin/owner roles are needed). For production, use real employee mapping and normal manager permissions; this exception must never be deployed to production.
- Exact allowed operation: `staff.authenticator.enroll`. `staff.authenticator.invite` is a distinct permission and is not granted by this module.
- The caller must supply a **trusted real passkey verifier** such as the existing `passkeys.verifyStrongManager`. The policy independently checks the employee-bound and fresh (maximum five minutes) verified passkey proof and exact same-origin context; it does not accept arbitrary browser-provided proof JSON.
- PIN or TOTP alone never approves; no recovery, factor reset, workstation enrollment, broad Lightspeed operations, or employee changes are granted.
- The existing approval subsystem **also verifies** the manager's signed passkey token and checks the exact operation before changing any request state. The policy is not a substitute for that proof.
- No TOTP seed/QR routes are mounted at present. Required migrations, key custody, immutable audit, CSP, revocation, owner acceptance, and full request → proof → approval → setup → six-digit confirmation tests are separate release gates.

## Tests
`tests/shared-security-isolated-owner-approval.test.mjs` covers exact test environment, operation, owner, employee, Origin, freshness, signed passkey proof, disabled flag, and all denied actions. The policy is mirrored to stacked Phase 2. It does **not** demonstrate real WebAuthn device registration or an actual Authenticator enrollment, which remain unverified.

## Next integration
1. Deploy and verify the independently keyed first-Owner passkey pilot in isolated staging after explicit review and approval; use the authenticated ceremony to start its four-hour one-time window.
2. Confirm real device WebAuthn registration and verification and a working backup/recovery plan.
3. Add and review the existing `hc_staff_factor_approvals` and `hc_staff_totp` migrations, separately protected encryption keys, request throttling and exact operation grants.
4. Compose the existing security subsystem only behind `HC_STAGING_OWNER_APPROVAL_ENABLED` and a new, separately approved enrollment flag. Never enable factor recovery simply to simplify testing.
5. Check that a PIN-only request cannot approve itself, wrong operation/account/Origin cannot approve, and the verified passkey must be fresh and bound to the same test owner. Then verify a real Authenticator app with one six-digit code and durable audit.
