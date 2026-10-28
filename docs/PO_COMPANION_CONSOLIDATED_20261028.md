# Purchase Order Companion — consolidated reconciliation (2026-10-28)

**Status:** IN DEVELOPMENT; no merge/deploy/release; Lightspeed writes disabled.

## Source comparison
- Current authoritative base: `integration/hobby-corner-consolidation` at `24e9834a6` when reconciliation began.
- Previous PR #13 `feature/po-companion-consolidated-v2`: 72 commits behind, 33 commits ahead, mergeable=false.
- Overlaps: `extension/popup.html`, `extension/popup.js` with PR #26; `extension/shared-ui/clipboard.mjs` with shared UI/Scanner; feature-local `navigation.json` disagreed with the shared extension navigation registry; manifest background worker collides with future unified worker, requiring release coordination.
- PR #26 provides `extension/shared-ui/navigation.mjs` and `navigation.css`, using verified destinations and extension-local Scanner/Toolkit targets. Reused those exact files as the baseline for POP/Scanner UI. PO feature uses this single registry instead of old `po-companion/navigation.json`.

## Ported
- PO supplier-side panel with read-only SKU/UPC copy, product name, quantity, warnings, draft field controls.
- PO separate review window (approval disabled).
- Shared navy/blue `hc.css`, clipboard utility, and original icon and wordmark binary assets.
- PR #26 Toolkit UI and shared navigation, then **additive** PO selection/launcher buttons and handlers; retained scanner, Split/Recall and other popup actions.
- Module background worker for shared PO navigation/icon/CSS/review messages; `HCT_PO_LOGIN` and `HCT_PO_LOAD` are explicitly fail-closed.
- Existing manifest permissions retained; no version bump. Background worker added as ES module for shared nav import.

## Actual API/auth assessment
- Current `special-orders.js` uses Lightspeed API `/api/2026-04/purchase_orders` and `/api/2026-04/purchase_orders/{id}/line_items`, with current ordering PO read logic already implemented.
- The former PO feature branch's `/api/2.0/consignments` read-route implementation was **not ported**.
- Scanner Timeclock session/authorization is existing infrastructure; no PO-specific authenticated 2026-04 read route or permission-controlled approval was activated. Real Lightspeed response/pagination, supplier mapping, active employee PIN/role behavior have NOT been live-tested. Existing PO UI cannot load live lines until this gap is closed.
- Draft persistence and UI event handlers retained, but loaded data and review before/after remain unverified; avoid presenting feature as complete.

## Test status
- Added `tests/po-companion-consolidated.test.mjs` for static PR26 navigation compatibility, extension launcher preservation and read-only guards. NOT YET EXECUTED in CI.
- Chrome browser testing, zoom/accessibility, clipboard leading zeros and real PO API/auth tests NOT performed.
- Zero production deployments, no Lightspeed writes.

## Next
1. Run Node CI and Chrome (separate profile/unpacked) browser checks with PO and scanner regression coverage.
2. Define reusable authenticated read-only PO query using current Ordering 2026-04 API contract and server-side Timeclock identity, not supplier-page PIN storage.
3. Verify supplier-specific SKU/UPC mapping and identifier fidelity on real PO data; reject ambiguous mappings.
4. Reconcile shared UI/navigation and background worker with other extension PRs immediately before merge; update release queue then.
