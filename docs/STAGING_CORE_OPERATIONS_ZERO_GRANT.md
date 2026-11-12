# Staging-only zero-grant admission gate (2026-11-12)

**System:** Core Operations guard for independently deployed Hobby Corner web foundation. **Status:** In Development / testing; no production deployment or grants.

**Source:** `Tawgod/Lightspeed:feature/pr63-staging-zero-grant-guard-20261112` from combined PR #63's previously SQL-verified commit `90e91c9b4d6cd07df1dff3de79100073bb819a72`. This is a **separate branch**; no change to PR #63, production or Owner login sources.

The gate activates only if all are true:
```
NODE_ENV=staging
HC_SECURITY_ENV=isolated-staging
HC_STAGING_CORE_GUARD_ENABLED=true
SPECIAL_ORDERS_LIVE_MODE=false
SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES=false
SPECIAL_ORDERS_ALLOW_MIGRATION=false
SCANNER_ENABLED=false
HC_ADMIN_NAV_ENABLED=false
```

If any real vendor credentials, legacy admin key, Timeclock/Scanner secrets, or Admin grants DB URL are present, startup fails closed with a configuration error. When activated, the **only** approved route list is `[]`: business routes return HTTP 403 before DB/vendor processing, public `/api/special-orders/health` remains readable. `/auth-check` preserves its existing preexisting behavior and cannot grant access without a separately configured signed session. No synthetic actor/token is publicly mintable; no employee, worker, Owner, or machine grants are provisioned.

**Automated tests** run real Express requests against the actual guarded Special Orders router with fake bearer/key/role/service headers. Positive synthetic service/staff tests remain in the existing `core-operations-route-admission.test.mjs` and `core-operations-route-seam.test.mjs` local fixtures; these do not create remotely usable credentials. Real positive employee authentication and grant tests will require separately reviewed staging-only credential issuance and the existing first Owner WebAuthn ceremony.

**Important:** This is the first *negative-auth* staging gate only. It does not turn on Owner login, Timeclock employee access, or Admin navigation. It is NOT a production-ready store UI because dashboard reads are denied until independent signed identity verification is commissioned. Deployment to the **dedicated PR63 isolated Railway project only** requires explicit environment flag changes and service pin updates; no central gateway or production source change is authorized.
