# Purchase Order Companion — development foundation

Status: In Development; not deployed; no Lightspeed writes.

Branch: `feature/po-companion-readonly-foundation` based on `integration/hobby-corner-consolidation`.

## Implemented
- Existing extension toolbar offers "Use Current Lightspeed PO" from a detected PO page.
- Employee can explicitly inject a compact, collapsible right-side Shadow DOM panel into an active HTTPS supplier tab. It can be toggled off.
- Panel implements item rendering, supplier-SKU/UPC copy selector, per-line selection, RP/RQ/cost/MSRP draft fields, and PO/supplier-scoped storage structure, but **no live items are populated yet**.
- Dedicated review popup lists selected draft fields without any save/approval action.
- No changes to existing scanner, Lightspeed content script, or Railway backend routes.

## Deliberate limits
- Panel currently shows an explanatory empty state, not live PO data. It does not claim to verify suppliers, current values, or warnings.
- Do not enable editing or approval until backend enforces supplier/product resolution and Timeclock authorization.
- Drafts are local, keyed by Lightspeed PO ID and supplier ID (currently unresolved), so they are placeholders only.
- Existing PO ID parser supports `/inventory/purchase-order/{id}`; verify exact navigation patterns at store.
- The on-page panel requires HTTPS supplier pages and explicit toolbar activation.

## Next implementation
1. Extract the existing `/api/2.0/consignments/:poId/products` read path from the Avery generator.
2. Resolve consignment supplier to `suppliers.lightspeed_supplier_id`, use `supplier_products` restricted to that supplier, and reject missing/ambiguous matches.
3. Add a strictly read-only, employee-authenticated API on `special-orders-test` based on existing scanner identity/session utilities. Return canonical PO line IDs, original values, warning codes, and a version token.
4. Bind response to panel line rendering only after verifying PO ID, supplier ID, and session; do not send server credentials to the browser.
5. Add field validation, draft reconciliation on changed PO, and review popup before/after comparisons.
6. Add automated tests for mismatched suppliers, ambiguous SKU, collapsed-field draft persistence, PO switching, session expiry, permission revocation, and read-only routes.
7. Test extension manually on a real supplier site using a locally loaded development build. Require explicit approval before any Railway deployment or Lightspeed writes.

## Safety
No backend write endpoint exists for this feature. The review approval button is disabled. The panel cannot scrape, type, or submit on a supplier website.
