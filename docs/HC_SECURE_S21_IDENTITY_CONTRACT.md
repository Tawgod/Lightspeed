# HC Secure S2.1 — independent identity integration proposal

Status: design only, not approved for deployment or actual grant assignment. Parent be24458aa6281834591da52f865af8b98c89b366. Existing Timeclock deployed pin a595fd336c5a38dcc5ab5423a8967698777c0929.

## Verified current boundaries
- staging/hc-secure-runtime-readiness.js explicitly rejects HC_OWNER_TIMECLOCK_SERVICE_SECRET; do not add it to running readiness configuration.
- services/security/ownerTimeclockStagingBundle.js currently uses scannerTimeclockIdentity mode owner-staging. Existing Timeclock timeclock/ownerStagingIdentity.js mounts only an exact selected active employee, checks separate credential and durable account-global limiter, returns scanner-derived permissions. Scanner access is not an Owner grant or suitable canonical employment identity policy.
- Original routes, credentials, throttle and Owner database must remain intact. Never issue a new activation as part of this milestone.

## Proposed independent interface (review required)
- Separate Timeclock backend route namespace /api/timeclock/integrations/hc-secure, default disabled, independent credential and throttle key; never accept original Owner, Scanner, administrative or browser credentials. Explicit selected Owner ID initially; no broad roster or employee PIN search. Future employee self-discovery requires separate review.
- POST verify-pin takes exact selected employee ID and four-digit PIN; POST authorize takes exact selected ID. Both check active canonical Timeclock record. Return only canonical ID and active status (name only if justified); never return or accept Owner/role/permission claims. HC Secure independently checks Owner assignment and strong factor. No business mutations.
- Require exact authenticated service audience, TLS on cross-project requests, reject browser-origin requests and redirects, generic denial, no raw request/credential logs. Separate durable limiter namespace and independent HMAC key; database schema/privilege review before any migration. Fail closed on throttle/database unavailable, wrong/inactive ID, malformed response, timeout, expired/revoked credential. Do not use scanner canLookup as employment status.
- Credential naming proposal: Timeclock HC_SECURE_IDENTITY_ENABLED, HC_SECURE_IDENTITY_EMPLOYEE_ID, HC_SECURE_IDENTITY_SERVICE_SECRET, HC_SECURE_IDENTITY_THROTTLE_SECRET; HC Secure existing HC_OWNER_TIMECLOCK_SERVICE_SECRET and approved HC_OWNER_TIMECLOCK_ORIGIN. Names provisional. No secrets set. Compare against all applicable legacy service credentials privately, not via logs.
- Keep the current readiness executable and source pin untouched; separate future activation executable must enforce exact Railway project/environment/service, exact HTTPS RP/origin and restricted database role. No public auth until separate review.
- Six independent application secrets may be commissioned privately with readiness remaining disabled: five >=32 byte signing/HMAC values and a distinct 32 random byte standard-base64 TOTP key. Existing validator checks duplicate string values among signing/service keys but not encryption key equivalence; future preflight must check canonical encodings and independent key material without printing values. Names-only inspection cannot prove entropy or independence. Review exact staged patch before acceptance.

## Test/approval gate
Synthetic tests before any activation: disabled/missing/malformed credentials, wrong audience, original Owner and Scanner credentials denied, valid selected active employee, wrong/inactive/901 employee denied, wrong PIN, limiter exhaustion and failure, DB failure, malformed upstream response, redirects/timeouts, no role claims, original routes unchanged. Real disposable DB throttle concurrency and rollback; then isolated staging compatibility. No live staff data or production traffic until explicit approval. Timeclock implementation must branch independently from its verified deployed pin; HC Secure client changes from its existing security pin. No shared business V4 branch or merge.

## Manager dependency
Canonical identity is distinct from operation authorization. Core needs trusted actor, exact effect grants, execution-time revocation checks, replay binding, output projection and audit correlation; registry names/precedence remain unapproved. No new business permission is created by this proposal.
