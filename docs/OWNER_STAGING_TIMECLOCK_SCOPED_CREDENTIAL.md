# Owner staging — dedicated Timeclock credential design (candidate, not deployed)

**Status:** Planned / security review required. Branch: `feature/owner-timeclock-scoped-credential-20261110`, based on `integration/hobby-corner-consolidation`. This document proposes additive access only; no implementation, route deployment, or production credential changes are authorized by creating this branch.

## Verified existing contract

Production `timeclock/server.js` exposes `POST /api/timeclock/integrations/scanner/verify-pin` and `/authorize`, both gated exclusively by one `SCANNER_SERVICE_SECRET`. The existing Owner stage wants a `HC_OWNER_TIMECLOCK_SERVICE_SECRET`, restricted to an independently confirmed existing active Timeclock employee ID, but cannot currently obtain a separately scoped credential. Using the shared Scanner secret would enlarge its exposure and should not be the default.

## Proposed additive, deny-by-default design

1. Introduce separate server-side `OWNER_STAGING_SERVICE_SECRET` (minimum 32 random bytes) and `OWNER_STAGING_EMPLOYEE_ID` (canonical active Timeclock ID) only after production change approval. They must never be browser-visible, logged, copied from Scanner, or sourced from an unverified request body. Optional `OWNER_STAGING_IDENTITY_ENABLED` defaults false.
2. Expose distinct `/api/timeclock/integrations/owner-staging/verify-pin` and `/authorize` routes only when configured and enabled, with a constant-time credential comparison, allowlist to exactly the configured employee ID, active-status recheck, no employee enumeration, and generic 401/403 responses. Do not weaken/change Scanner or Timeclock PIN login.
3. Enforce durable per-account and verified-source rate limiting at the Timeclock boundary itself (not only staging app), short timeouts, no-store headers, strong HTTPS/private network and audit without sensitive payloads. If durable throttle is missing, fail closed.
4. Have the staging identity adapter use these separate endpoints and its dedicated credential; ensure the existing scanner API remains unaffected. No production Owner role assignment from these routes.
5. Automated test cases: disabled/missing settings; wrong token; shared Scanner token denied; other employee and synthetic 901 denied; wrong PIN; inactive employee; retry/guess throttling; forged headers; staged operation logs; server restart; existing Scanner/Timeclock regression.
6. Before production Timeclock rollout: code/security review, deploy/rollback authorization, stored-secret provisioning, private ID verification, staging application acceptance, and documented recovery. No deployment without explicit separate permission.

## Current staging

Dedicated Railway project `HC Owner Security Staging` is staged, not deployed. App source pin `b17f274910145b324462edc2ec2893a99eb0ca2f`; database version and least-privilege roles unresolved. New domain cannot be generated until a service instance exists. Do not apply a partial staging patch: app startup intentionally fails without prerequisite roles, migrations, secrets and WebAuthn HTTPS origin.
