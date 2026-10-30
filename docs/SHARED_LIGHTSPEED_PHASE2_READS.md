# Phase 2 Shared Lightspeed Reads — Candidate Contract

**Status:** In Development / Testing (not merged or deployed). Final permission contract CI passed on PR run `40919331215`.
**Work branch:** `feature/shared-lightspeed-services-phase2-reads-20261029`
**Dependency:** Phase 1 PR #32 / `feature/shared-lightspeed-services-phase1-20261029@7c20b3d9f90382b6fafeb5dc3d9a92108f4c14e1`
**Authoritative code:** `Tawgod/Lightspeed:integration/hobby-corner-consolidation` until explicitly merged and deployed.

## Implemented (development-only)

- `services/lightspeed/readCollection.js`: strict bounded X-Series version-cursor collection reads and offset-based search pagination, vendor shape validation, missing/ambiguous last-page detection, continuation cycle and off-host redirect rejection.
- `services/lightspeed/products.js`: Lightspeed remote product reads and exact SKU/UPC/product-code verification. Never select the first vendor result when an exact identifier was not found; preserve SKU zeros; reject ambiguous identities.
- `services/lightspeed/inventory.js`: outlet/inventory-by-product read, preserves vendor representation and does not synthesize quantities when data missing.
- `services/lightspeed/sales.js`: sale get and legacy invoice/customer/state read paths; no sales writes.
- `services/lightspeed/fulfillments.js`: sale fulfillment list read and normalized status with raw internal payload retained.
- `services/lightspeed/purchaseOrders.js`: PO list and lines via the same `2026-04` endpoints used in current Ordering and PO Companion candidate. Requires complete lists and unique PO identity. Supplier SKU, UPC and SKU remain strings, including leading zeros; absent quantity remains null rather than silently zero.
- `services/lightspeed/storeCredit.js`: read-only store credit; no credit transaction capability.
- Updated Phase 1 customer search and supplier/brand/tag read contracts to reject potentially truncated list responses.
- `routes/sharedLightspeedRead.js`: **UNMOUNTED** authenticated read-only gateway router factory, with operation-scoped existing Timeclock-backed staff policy. Response envelopes include `readOnly:true`. Production `server.js` is unchanged.
- `tests/shared-lightspeed-reads.test.mjs`: pagination/redirect/duplicate/leading-zero/permission/read contract tests.

## Shared employee/session permission contract

- `services/lightspeed/permissions.js` declares the **exact canonical operation IDs** used by the new read gateway and provides `createHobbyCornerStaffLightspeedPolicy` for verified existing Timeclock sessions. It does **not** create a second employee or PIN system.
- New shared reads require an active, server-verified Timeclock employee and `canLookup === true`. Current Timeclock `scannerEffectivePermissions()` grants Scanner lookup and review approval to every active employee; do not assume persisted `scanner_can_* ` columns currently restrict those permissions.
- New shared writes are **denied by default** even if `canApprove === true`. Explicit server-only operation-specific write grants, construction-time write gates, audit, idempotency and readback are mandatory before any production mutation.
- Independently verified service principals require explicit exact-operation service grants; browser-provided role claims never authorize access.
- Existing Core Operations employee edit/create workflows remain unchanged; introducing restrictions there requires an independent store policy and browser acceptance review.
- Shared specification: `Tawgod/Hobby-Corner:main/SHARED_STAFF_AUTH_PERMISSIONS.md`. Regression tests: `tests/shared-lightspeed-permissions.test.mjs`.

## Important boundaries

- **Do not merge Phase 2 onto the Railway-connected integration branch before Phase 1 approval and release coordination.** The Phase 2 PR is stacked onto the Phase 1 branch.
- No extension, UI, API routing, DB migration, production Lightspeed data, Railway environment or customer/employee record is changed.
- Shared gateway endpoints remain unavailable until mounted explicitly after acceptance testing. No new production write APIs.
- Versioned route paths are derived from current application source; pagination semantics were cross-checked with current official Lightspeed X-Series documentation. Real-tenant compatibility, scopes and return shapes still require a read-only acceptance pass.
- The current PO Companion PR #31 owns its authenticated local supplier mapping and staff workflow. Its route must later consume this PO read contract without dropping reviewed values or introducing direct production credentials.
- Feature-level customer/profile enrichment, PO local supplier mapping and Special Orders business workflow remain feature-owned; shared module owns only vendor read semantics.
- The remote exact product reader checks multiple currently used vendor paths; incomplete replies refuse rather than infer absence. It must **not** automatically create a product.
- The strict pagination helper follows documented version.max cursor chains until empty for collection endpoints, and offset until a short/empty page for /search. It fails closed on non-advancing cursors, row/page caps or unknown full-page responses. The SKU-filter list is treated as a single-page candidate because the API ignores other query parameters when SKU is provided; independent offset-paginated search supplies the exhaustive duplicate check.

## Recommended controlled consumer sequence

1. Run CI and code review for this stacked PR. Verify API versions and pagination with real read-only test tenant credentials before mounting the gateway.
2. Introduce an internal, controlled switch for one existing read consumer, with byte/shape parity fixtures.
3. Switch PO Companion and Ordering read-only PO lookup to `purchaseOrders.js`, preserving local supplier SKU mappings, draft state and authorization.
4. Switch customer and product lookup without altering Special Orders/Scanner match-or-create semantics.
5. Migrate inventory, sales/fulfillments and store-credit reads using feature-specific regression checks.
6. Only after all read consumers pass, plan Phase 3 controlled production-write conversion.

## Existing exception policy

Scanner isolated test-store writer and RMS bulk migration remain separate. The shared gateway must never be configured with test and production write credentials interchangeably.

## Official API reference verified 2026-10-29

- X-Series cursor-based pagination: https://x-series-api.lightspeedhq.com/docs/pagination
- Search uses `offset`/`page_size`: https://x-series-api.lightspeedhq.com/v2026.04/reference/search-1
- PO list uses version cursor: https://x-series-api.lightspeedhq.com/v2026.04/reference/listpurchaseorders
- Product `sku` lookup ignores other list params: https://x-series-api.lightspeedhq.com/reference/listproducts
- Inventory redesign: https://x-series-api.lightspeedhq.com/docs/2026-04-release-notes — the existing Special Orders GET /inventory/:id is retained for a compatibility read. Bulk inventory and inventory-level scans must use the documented POST read endpoints in later migration work, even though the HTTP method is POST; never confuse that read operation with a write permission grant.

## Phase 1 safety hardening synchronized on this stacked branch — 2026-10-29

The stacked Phase 2 branch now contains the same reviewed Phase 1 safeguards: conservative uncertain-write HTTP results; strict/local API paths; streamed response byte limits and strict JSON success; deterministic plain-JSON payload fingerprinting with mutation-race protection; read-only PostgreSQL pending/unknown-key inspection; audited replay safety and audit TRUNCATE coverage. There are **no new production routes or production vendor write permissions**. These changes must be inherited from PR #32 when the stacked branch is finally rebased/retargeted, without accidentally dropping the Phase 2 read/permissions test expectations.


- Additional transport integrity guard (2026-10-29): streaming JSON decoding uses fatal UTF-8 validation, rejecting malformed byte sequences instead of silently replacing characters in product identifiers. Covered by regression test; not mounted in production.

**Defense in depth (transport opt-in):** `createLightspeedTransport` now defaults to `mutationsAllowed:false`. POST/PUT/PATCH/DELETE are refused *before network activity* unless a trusted backend constructor explicitly opts in. This option does **not** replace the independent verified identity, permission, durable audit/idempotency and readback gates; downstream write consumers must use all gates. Any future vendor read endpoint requiring POST must have an explicitly reviewed dedicated read-only handling contract rather than silently enabling arbitrary mutations. The default remains safe for existing GET/HEAD read consumers.

## Staff security assurance baseline candidate — 2026-10-30

- Reusable, **unmounted** `services/security/staffAccessBaseline.js` explicitly classifies Timeclock status/clock, normal tool read/staging, product/PO/inventory/sales/credit writes and staff-permission changes.
- A verified Timeclock employee session **alone** is insufficient: low-risk actions also require a separate, server-verified registered workstation or independent strong sign-in; high-risk writes/permissions require a fresh bound passkey, security key or OIDC MFA proof and an exact server-side operation grant. Spoofed browser role/device/header claims are not authority.
- Construction requires trusted backend identity and permission adapters; optional station and step-up validators fail closed. The policy is **not yet connected to live identity-provider, device enrollment, or legacy Timeclock routes**.
- Automated regression tests cover PIN-only denial, forged headers, expired/unbound factor proofs, missing grants, inactive employees and verifier failures. Last code/test CI [41091370610](https://github.com/Tawgod/Lightspeed/actions/runs/41091370610) **PASS**.
- Cross-tool design/migration specification: `Tawgod/Hobby-Corner:main/STAFF_SECURITY_BASELINE.md`. Existing public-facing Timeclock clock/status identity handling must be coordinated with Chrome content-script migration before it can meet this baseline; it must not be switched off blindly during store hours.
- No password/PIN, production credential, Timeclock data, Railway routing or extension deployment was changed.


### Durable employee/source login throttling — candidate only

- New `services/security/staffLoginThrottle.js` uses PostgreSQL token buckets with **two independent budgets**: per selected employee ID and per server-observed source IP (not an IP+employee pair, and not a store-wide hard lock). All keys are HMAC-hashed with a dedicated secret. The account selector is never considered authentication.
- `db/hc_staff_auth_throttle.sql` is a **separate unapplied additive migration**; it stores only HMAC key hashes, token balances, and timestamps (no PIN, employee names, source IPs, raw headers, or access tokens). DB transaction row locking serializes concurrent attempts across replicas.
- Blocked bucket timestamps do not advance, so repeated attack traffic cannot create an indefinitely extended timeout. Database failure denies sign-in instead of bypassing throttling.
- Call before each PIN verification in any future public credential route; use a non-secret explicit employee selector. Backend must derive a trustworthy source IP from validated proxy configuration; browser `X-Forwarded-For` is never identity/authorization.
- This is a **candidate for future migration**, not an automatic replacement for the existing live `scannerLoginLimiter`. Runtime auth paths, endpoint names and employee PIN behavior are unchanged until approved/accepted.
- Tests use the disposable PostgreSQL CI instance to verify cross-replica concurrency, independent account/source ceilings, unavailable storage failure, hashed stored keys, cooldown recovery and non-extending block windows. Include in the final PR CI workflow before considering acceptance.

## Optional Google Authenticator TOTP candidate — 2026-10-30

- Implemented **unmounted**, RFC 6238 / standard Google Authenticator-compatible 6-digit TOTP in `services/security/staffTotp.js`, with unique random 160-bit secrets, SHA-1/30-second setup URI, and ±1 time-step handling.
- `services/security/staffTotpPostgres.js` performs server-approved employee enrollment and confirmation, 10-minute pending expiry, five failed confirmation attempts, and authenticated verification. Server-only AES-256-GCM key protects enrolled secrets at rest, with unique nonce and employee-bound associated data; `db/hc_staff_totp.sql` is a **separate unapplied** candidate.
- TOTP code checks require a verified Timeclock session and durable independent employee/source login throttle; each successful time step is atomically consumed using PostgreSQL row locking. Verified claims MUST be bound to a fresh server-signed employee session by a separate integration adapter; returning a JSON proof is not client authorization.
- `staffAccessBaseline.js` recognizes backend-verified `totp` for normal remote read/staging without workstation/extension, but denies TOTP-only sensitive product/PO/inventory/sales/credit/permissions writes. Passkey/security key or trusted IdP MFA stays the current privileged-operation path.
- Tests in `tests/shared-staff-totp*.test.mjs` cover RFC vectors, enrollment URI, encryption, approval, limits, simultaneous replay, revoked session and write downgrades. Final source CI: [41116244954](https://github.com/Tawgod/Lightspeed/actions/runs/41116244954) **PASS**.
- **Not deployed / not wired:** No QR/setup screen, mobile auth endpoint, password/PIN changes, TOTP factor reset/recovery, signed MFA session issuance, key provisioning or live Railway migration. Legacy Timeclock clock/status route bypass still requires its coordinated Chrome/backend remediation.
- Canonical design: `Tawgod/Hobby-Corner:main/STAFF_SECURITY_BASELINE.md`; default off until explicit security, migration, recovery and employee acceptance approval.

