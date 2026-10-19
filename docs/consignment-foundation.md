# Consignment foundation (2026-10-19)

Status: In Development (layout preview only). No testing against live Lightspeed, deployment, or customer-facing access.

Repository: Tawgod/Lightspeed
Base: integration/hobby-corner-consolidation
Feature branch: feature/consignment-layout-foundation

## Agreed layout
- Standalone management UI alongside existing Special Orders, with navigation links both ways once routed.
- Chrome extension is only a lightweight launcher/status entry point; do not embed a full consignment manager inside content scripts.
- Customer portal will show submissions, item status, sales, and credits after secure identity integration.
- Existing Lightspeed customer UUID is the customer reference; do not equate POS customer records with web-store sign-on sessions.
- Reusing the Lightspeed Online login requires verifying supported SSO/OAuth/delegated identity or a supported identity handoff. Do not collect or store Lightspeed passwords, scrape session cookies, or claim customer login compatibility without provider support.
- All consignment products use the dedicated category General > Consignment. Resolve and validate the actual category UUID before writes; never silently create a different category.
- Unique consignment item IDs (e.g., UG-001284), no recycled primary SKU. Prefix display name with USED — and preserve a dedicated used flag/identity in the ledger.
- If matching an existing/historical new product, offer an explicit source selection with product UUID. Copy only curated informational fields (e.g. brand, descriptive specifications) after review. NEVER copy images, stock, UPC/barcode, supplier-cost fields, original product SKU, or supplier reorder settings. Do not accidentally associate the used item with new stock.
- New used item listing defaults in-store only. Online enablement requires staff opt-in and channel validation, plus unique photos or no photos rather than copied pictures.
- A submission includes multiple independently approved items; rules, inspection fields and terms differ by Game, Puzzle, RC and other.
- Hold three full days from verified POS sale before exactly-once credit to the consignor; differentiate RC no-return agreement from Game/Puzzle return windows.
- Age, quantity limits, warnings, price-change approvals, customer credits and audit trail live server-side and cannot rely on the extension.
- Staff roles and login must be verified before any private customer information is exposed. No public operational endpoints.

## Layout preview
- consignment-layout.html is standalone static developer preview. It has no real data and intentionally makes no API writes.
- Pending integration: route /consignment, add navigation link to /special-orders, add light extension launcher through coordinated release queue.
- Release queue review REQUIRED before any extension release. This branch makes no extension code changes.

## Next
1. Inspect backend authorization model and special-orders hosting; choose a secure staff route.
2. Verify vendor documentation and Lightspeed Online identity options, POS account credit API, product variant/metadata and online listing APIs before customer portal or financial writes.
3. Create SQL schema, auditable lifecycle, sample fixtures, API and staff UI wired to test database.
4. Add explicit existing-product lookup and curated copying with image omission; duplicate SKU protection.
5. Request staff feedback on layout, then queue extension launcher in CHROME_EXTENSION_RELEASE_QUEUE.md and coordinate next extension release.
6. Confirm business policy for store credit reversal if a POS transaction is voided or refunded after credit posting.

## Development progress (2026-10-19, phase 2)
- Added GET /consignment standalone preview route to server.js and Special Orders toolbar link.
- Added db/consignment_schema.sql (NOT automatically initialized or deployed): consignors, submissions, reusable product templates, individual items, credit ledger, event history.
- Added online-submission match review explanation to UI; matching is not connected yet.
- Decision: one unique physical consignment item and unique Lightspeed SKU per accepted copy. Never reactivate an already credited physical-item SKU. Reuse a template/product match instead; when sold and credit reconciled, deactivate the sold item's Lightspeed product, subject to return/refund and online-listing safety checks.
- Matching should run for staff entries AND customer-submitted online items when staff opens the pending submission, searching active and inactive/historical NEW products, without automatically accepting matches. Product photos are excluded from copying.
- Security: schema is not a public API. Any staff/customer list and matching details require authorization. The static preview displays no real records.
- Outstanding: implement protected list/search endpoints and a candidate-match scorer; verify Lightspeed inactive product API before enabling writes; integrate authenticated customer portal; implement extension launcher only after release-queue reconciliation.
