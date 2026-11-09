# Product Manager — phase 1 foundation (2026-10-27)

Status: In Development. Authoritative base: Tawgod/Lightspeed:integration/hobby-corner-consolidation.
Development branch: feature/product-manager-foundation-2026-10-27.

## Existing systems to reuse
- Product Scanner: extension/product-scanner/review.js and special-orders-adapter.js provide existing supplier capture, matching and protected employee review flows. Do not create a competing match API.
- Special Orders: existing PostgreSQL supplier-product relationships, product reconciliation and controlled new-product workflow. Integrate through these functions only after source-specific review.
- RMS migration: validation, category/brand/supplier mappings, SKU collisions and supported retailer legacy product endpoint. Do not copy write-enabled migration routines into staff UI.
- Label launcher: preserve existing Avery workflow. Sale-label jobs should be handed off, not implemented as independent printing engine.
- Image pipeline: Drive Lightspeed Ready / Attention and image-upload logic in legacy importer; prefer server-side audited matching and approval.
- Product Manager v0.9: demo-only browser interface, not connected to live inventory.

## Phase plan
1. Inventory supported X-Series / E-Series fields and actual integration sync ownership. Implement read-only product/variant/supplier adapters with paging, caching, and explicit data provenance.
2. Wire normalized read model into grid; saved employee layout profiles; multiple suppliers, images, documents where API permits, shared custom fields.
3. Stage individual/bulk edits with original values; validation, diff preview, permission checks, concurrency conflict detection, explicit approval, idempotency keys, audit events, and per-record readback. Disable writes by default.
4. Reuse scanner/SO new-product match/create approval, map CSV rows into identical validation flow.
5. Link Google Drive image suggestions by strong SKU/UPC match first, then approved common-code suggestions. No filename-only automatic upload.
6. Add aging metrics (first stocked, last receipt, last sale) with dates and stock movement coverage verified; reviewed discount plan -> existing Avery label workflow.
7. Optional AI suggestions layered after deterministic checks. Never let AI directly modify products.

## Safeguards and gaps
- validation.js is deliberately pure, read-only and PREVIEW_ONLY: no API calls or credentials.
- Committed quantity must be computed from SO and existing Lightspeed holds using reconciled stable reservation identities; do not double count mirrored records. Current function de-duplicates per source only; cross-source identity reconciliation still required.
- Product manuals: verify X/eCom attachment semantics and hosting before enabling writes; do not promise arbitrary document upload.
- E-Series Ecwid max purchase quantity and SEO fields may be writable in isolation but integrated sync behavior must be tested.
- Online toggle is X-Series authority. Variant edits need variant-specific source identities.
- No runtime routes, Chrome extension changes, Railway configuration, DB schema changes, or production deployment in this phase.

## Required tests before review/approval-enabled writes
- Authorized employee permissions and active status; CSV injection/HTML sanitization.
- SKU / UPC duplicate and category validation against latest X data.
- Compare optimistic old-value checks, stale snapshot rejection and idempotent retries.
- Per-product partial-failure recovery and read-back, scoped approval roles.
- E-Series sync conflicts, images ordering, downloadable manuals and rate limits.
- Inventory reservation reconciliation and label quantity safeguards.
