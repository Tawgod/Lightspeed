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

## Shared Addon UI beta adoption — 2026-10-27

**Authoritative design:** Tawgod/Hobby-Corner:main/SHARED_ADDON_UI_UX.md
**Foundation:** Tawgod/Lightspeed:feature/shared-addon-ui-beta-foundation-20261027, draft PR #16, not merged.
**Current feature PR:** #13, still draft.

Screens updated: injected supplier PO panel; independent PO review popup.
Reused foundation files (version-locked copies only within extension/ because the extension distribution includes extension/ only):
- extension/shared-ui/hc.css; hc-ui scope, hc-button, hc-input, hc-select, hc-inset, hc-alert, hc-panel, hc-topbar, hc-mono, hc-panel--drawer.
- extension/shared-ui/assets/hc-icon.webp and hc-wordmark.webp, exact original binary files copied via Git objects; no graphic redraw.
- extension/shared-ui/clipboard.mjs included for future rich-copy use; current SKU/UPC interaction retains exact string via native clipboard.writeText because imported extension modules need separate web-accessibility review. This is intentional, not rich text support.

Panel uses extension worker to load CSS and send original icon as a data URL to the isolated Shadow DOM, avoiding broad web-accessible resource permissions.
Review popup links local shared CSS and the original logo. Existing IDs, draft/event handlers and disabled authentication/write protections were preserved.
Local CSS still governs narrow supplier panel geometry; shared foundation governs design classes/tokens.

Static verification: JS syntax parsed for panel.js, background.js and review.js; shared CSS and review link present; panel read-only login gate still disabled. **No Chrome browser, zoom, clipboard, keyboard, employee authentication, or visual screenshot acceptance tests yet. No live PO read or write test.** Not merged, packaged, deployed or released.

Release dependencies: shared PR #16 remains draft; reconcile its eventual changes before packaging a PO Companion extension update; consider version-lock update if foundation changes.
