# PO Companion consolidated v2 — October 27, 2026

Status: In Development; not browser-tested; not deployed; no Lightspeed writes.

Base: `integration/hobby-corner-consolidation`, not `feature/po-companion-readonly-foundation`.
Old branch reconciliation: at review, old branch was 133 commits behind and 19 ahead. Its PO backend uses older consignments endpoint, while the current Ordering workspace uses the Lightspeed 2026-04 purchase_orders and line_items API. Do not merge old branch wholesale.

Implemented in this branch:
- Standalone supplier-host right-side panel scaffold via explicit extension popup interaction.
- PO context capture from existing Lightspeed content message.
- Supplier SKU / UPC presentation and copy controls, expansion/draft state, separate non-writing review page.
- Background worker fails closed for PO fetch/sign-in while secure gateway implementation is pending.
- No extension version bump or released package.

Important gaps:
1. Validate 2026-04 PO response shape, paging, supplier and product IDs and server-side supplier_product matching.
2. Implement **authenticated read-only** PO endpoint reusing existing scanner session/Timeclock identity, with negative-case tests.
3. Connect panel to live PO response only after backend contract tests. Keep employee PIN in extension-owned context, never supplier DOM, and recheck permissions server-side.
4. Reconcile existing queue entries, PR #11 consignment launcher and PR #12 scanner permissions before release.
5. Validate draft persistence by PO+supplier and preview before/after comparisons; verify all writes remain disabled.
6. Run browser tests and CI, then submit for review; no Railway deployment without approval.

Queue: `Tawgod/Hobby-Corner:main/CHROME_EXTENSION_RELEASE_QUEUE.md`.
