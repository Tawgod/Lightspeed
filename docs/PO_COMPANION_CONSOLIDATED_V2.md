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

## Core navigation/Consignment-consistency follow-up — 2026-10-28

Reviewed owner audit in SHARED_ADDON_UI_UX.md, draft PR #23 core navigation, PR #16 foundation and current PO feature PR #13. PR #23 was open/draft; its verified list covers Special Orders, Ordering, Preorder Campaigns, GW Preorders, Consignment (Beta) and Lightspeed Toolkit. It does not yet supply a common registry module and does not include confirmed launch links for Timeclock, Scanner, Product Manager, PO Companion or Split/Recall.

Added one PO-specific, version-locked `extension/po-companion/navigation.json` list of the six PR #23 destinations (absolute URLs to known backend hosts; no invented extension page URLs). Both the supplier panel and standalone review window consume the same JSON rather than hand-authoring two different nav lists. The panel's small More menu avoids obscuring supplier content; the review window explicitly identifies PO Companion as the current page. Beta label preserved for Consignment. This is a feature-local bridge pending the central registry; **do not treat it as a replacement for PR #23**.

Modified `extension/po-companion/panel.js`, `background.js`, `review.html`, `review.css`; added `navigation.json`, `navigation.js` and `tests/po-companion-navigation.test.mjs`. Shared `hc-ui` design and original logo assets stay intact. No business API, role, matching, draft schema, extension manifest or Lightspeed write logic changed.

Source-level checks completed: panel/background/review/navigation JS syntax passed, navigation JSON parsed, link labels and static read-only guards inspected. Automated Node test file committed but not yet executed in CI; real URL availability/auth behavior, Chrome popup screenshots, 100/125/200% zoom, keyboard focus and live PO validation **pending**. No Railway deploy/extension package/merge.
