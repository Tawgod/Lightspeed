# PO Label Maker — Shared UI beta adoption

Status: **In Development** (implemented in isolated branch; browser acceptance pending)  
Date: 2026-10-27  
Owner: Lightspeed Labels  
Branch: `feature/labels-shared-ui-beta-20261027`  
PR: [#20](https://github.com/Tawgod/Lightspeed/pull/20) (draft)  
Base: `integration/hobby-corner-consolidation`  
Shared design: [PR #16](https://github.com/Tawgod/Lightspeed/pull/16) (draft), `shared-ui/hc.css`

## Screen adopted
Standalone `/index.html?poId=...` purchase-order label maker.
- Navy branded header, gray-blue canvas and shaded panels for template settings, item quantities, PDF generation.
- Blue primary Generate PDF action, shared focus behavior, styled responsive product table, status region and existing wordmark.
- Classes from the shared foundation: `hc-ui`, `hc-topbar`, `hc-page`, `hc-panel`, `hc-panel-header`, `hc-panel-body`, `hc-field`, `hc-input`, `hc-select`, `hc-table`, `hc-button`, `hc-alert`, `hc-loading`.

## Touched implementation
- `index.html` — structural/styling changes; preserves all existing input IDs, PO fetch and PDF POST workflow.
- `server.js` — two explicit static asset endpoints, no Lightspeed writes or PDF generator changes.
- `shared-ui/hc.css` — byte-for-byte shared foundation stylesheet copy for branch-local use. Reconcile with PR #16 when merged.
- `tests/labelSharedUi.test.mjs` — source regression checks.

Brand image remains the existing `extension/product-scanner/hc-wordmark.webp` already included on consolidated source. This branch does **not** modify extension files or package.

## Preserved behavior
PO item retrieval, templates, start row/column, custom text, SKU display, editable total/special-order quantity, customer assignment, skip buttons, and PDF generation route. Avery 5960 positioning/barcode logic unchanged.

## Verification
- GitHub source static checks: DOM IDs, existing fetch routes, Avery positioning constants, scoped UI root and asset routes passed.
- Added Node tests are **not yet executed**. CI/browser live PO test, mobile/zoom screenshots, keyboard, labels, error/loading, and physical Avery paper regression pending.
- No live Lightspeed writes tested or attempted; there are no additional write paths.
- **Not merged and not deployed.** No manifest/version/ZIP/release action.

## Dependencies / release
- Shared foundation PR #16 is draft; identical CSS contents require coordinated merge/reconciliation.
- Extension release queue inspected 2026-10-27; standalone label page change affects no Chrome extension files and is **not an extension release item**. Do not implicitly merge other draft extension PRs.
- Next: browser-test against a safe purchase order, verify visual/error states and physical print output, then seek separate integration/deploy approval.
