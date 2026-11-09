# Avery PO Label Maker — October 28 consolidated refresh

Status: In Development / automated tests pending / browser and physical-print acceptance pending.

- Authoritative base: `integration/hobby-corner-consolidation` @ `24e9834a6aaaec2fae5e656a65939e93b63143cf`
- Reconciled branch: `feature/labels-shared-ui-reconciled-20261028`
- Replaces older label UI draft PR #20, which was 24 commits behind.
- Existing shared stylesheet: `shared-ui/hc.css` from consolidated source (not copied/replaced).
- Scope: `index.html`, two asset routes in `server.js`, regression test and CI workflow.
- No Chrome extension files, version/package, Lightspeed writes, template JSON, or PDF drawing logic changed.
- The standalone page retains template and start-position controls, SKU/quantity/customer fields, label PDF POST, and current branding.
- Existing UI keeps original IDs and API request object.
- Label-specific regression tests: `node --test tests/labelSharedUi.test.mjs`.
- Browser smoke: verify with a non-sensitive valid PO on an isolated/test server, 100/125/200% zoom, narrow viewport, keyboard tab/shift-tab, readable loading/error messages, safe PDF open. NOT YET VERIFIED.
- Print acceptance: generate at 100% actual size (no fit-to-page), check Avery 5960 margins, all 30 cells, long names/barcodes, starting row/column and multipage. Physical printer verification requires store hardware and is NOT YET VERIFIED.
- No independent merge until automated CI and Chrome browser/physical-layout gates pass.
