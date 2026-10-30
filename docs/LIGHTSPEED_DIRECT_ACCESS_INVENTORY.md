# Direct Lightspeed Access — Phase 1 Consumer Inventory

**Audited:** 2026-10-29  
**Authoritative repo:** `Tawgod/Lightspeed:integration/hobby-corner-consolidation`  
**Shared-services candidate:** draft PR #32, `feature/shared-lightspeed-services-phase1-20261029`

## Observed ownership

| Existing source | Current behavior | Recommended migration | Rule |
| --- | --- | --- | --- |
| `services/lightspeedApi.js` | Shared client for sale, fulfillment, customer/product get and store credit | Preserve method paths/responses using `legacyReadAdapter.js` before converting writes | Do not replace production routes until parity tests pass |
| `special-orders.js` | Direct versioned client, customer search/create, PO and product helpers | Extract customer/product/catalog/read and then guarded writes incrementally | Timeclock-backed staff session remains authoritative |
| `routes/specialOrderProducts.js` | Mature product matching, deduplication, supplier resolution, product create | Extract `productIdentity.js`, retain duplicate guards, move guarded create later | Scanner depends on this working contract |
| `services/scannerSpecialOrdersLookup.js`, `routes/scannerMatchGateway.js` | Scanner match gateway consuming Special Orders rules | Continue using shared matching APIs; no duplicate writer | Scanner extension can remain a lightweight client |
| `services/scannerIsolatedTestWriter.js` | Explicit isolated test tenant writer | Intentional exception, never production fallback | Separate credentials and domain required |
| `routes/orderSplitExecute.js`, other split/recall routes | Existing `lightspeedApi.js` consumer for sale mutations | Read parity first, then protected shared sales service | Existing split/recall workflow unchanged until converted |
| `Tawgod/Hobby-Corner-Discord-Bot:main/rewards_service.py` | Independent Python Lightspeed client for rewards/custom fields | Eventually consume authenticated backend `customFields` contracts | Keep credential retirement until downstream conversion complete |
| `Tawgod/Lightspeed-Importer` and RMS migration branches | Controlled bulk import/migration | Reuse shared normalization only as appropriate | Migration-specific dry-run/authorization and no staff writer |

## Operational rules

1. Feature UI and business logic remain owned by their development workstream.
2. Shared API transport/authorization/mutations are gateway-owned.
3. Customer/product identity, catalog, inventory and PO read contracts are extracted before writes.
4. New production mutations require durable, scoped idempotency, verified Timeclock/service authorization, audit and readback.
5. `services/lightspeed/legacyReadAdapter.js` is opt-in only and contains no mutation methods.
6. Do not publish the Chrome extension, merge draft PR #32, or modify Railway production without a separate approval.
7. CI source detection is a **guard against common new direct API patterns**, not proof all direct clients were found. Manual PR review remains necessary.

## Verification/remaining work

- The Phase 1 Postgres persistence migration is a source file only and must be reviewed before execution in any real environment.
- API versions/pagination and employee permissions still require integration/runtime verification when consumers migrate.
- Current routes continue to call legacy implementations; no feature has been declared converted.
- Active UI and extension branches/PRs #22, #24, #26, #28, #30, and #31 were inspected earlier and do not touch the new `services/lightspeed/*` namespace. Recheck conflicts at merge time.
