# Shared Addon UI adoption — Product Manager, 2026-10-27

Status: In Development. No live employee screen or production route is changed.

## Sources and dependencies
- Authoritative app base: integration/hobby-corner-consolidation.
- Product Manager validation foundation: feature/product-manager-foundation-2026-10-27.
- Shared UI dependency: draft PR #16, feature/shared-addon-ui-beta-foundation-20261027.
- Current integration branch: feature/product-manager-shared-ui-20261027, branched from shared UI beta foundation, then carried over Product Manager validation files.
- Shared assets used **directly**: ../shared-ui/hc.css, ../shared-ui/assets/hc-icon.webp and hc-wordmark.webp. No duplicate component framework, logos, or theme palette created.

## Implemented pilot screen
- product-manager/index.html: shaded responsive shell, navy navigation/header, owner wordmark, sample product table, right details drawer, review-only change list and feedback regions.
- product-manager/ui.css: only Product Manager layout specifics; shared hc-* classes own colors, buttons, panels, form controls, tables and statuses.
- product-manager/ui.mjs: sample-only product search, inactive filter, product selection, editable staging, per-field undo, change preview, and empty/error feedback.
- Existing business-layer validation.js and tests carried into this branch unchanged.
- Preserves exact text in SKU and UPC displays; no numerical identifier coercion. HTML entities escaped before inserting demo data into markup.
- Distinguishes staging from approval and Lightspeed write: no Apply action exists.

## Deliberately not claimed / not yet implemented
- v0.9's comprehensive standalone UI has not been ported; that test artifact does not exist in authoritative GitHub branch. This pilot is incremental shared-kit adoption rather than full feature parity.
- Saved profiles, draggable columns, supplier/variant detail, CSV import, Drive image matching, rich descriptions, real user auth, and server data remain pending.
- The app currently requires serving from the repository root using a local HTTP server (ES module import); file:// may block modules in browsers.
- Browser visual, keyboard, zoom, clipboard and permission acceptance tests are pending. Production sync and Lightspeed APIs are not connected.
- No extension source, release queue, server.js, Railway config, PostgreSQL schema, or Lightspeed data changed.
- PR #16 is draft/unmerged; merging Product Manager independently would require coordinated dependency resolution.

## Acceptance plan
1. node --test product-manager/validation.test.js; node --check product-manager/ui.mjs
2. Serve repository via local HTTP, visit /product-manager/, inspect logos and 100/125/200% zoom.
3. Keyboard select rows, edit staged fields, undo exactly one, discard all; validate wrong price and empty states.
4. Paste and verify leading-zero UPCs and multiline descriptions on subsequent editor integration.
5. Verify no external network requests / live writes, then obtain employee visual approval.
