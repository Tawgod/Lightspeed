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

## Navigation consistency correction — 2026-10-28
- Source alignment: PR #23 (draft) `feature/core-ops-shared-navigation-20261027`; PR #16 (draft) shared tokens and logo assets; Consignment beta is the preferred visual reference.
- Updated `product-manager/index.html` with PR #23's `hc-operations-nav`, `hc-operations-links`, `hc-operations-brand` patterns, current-page marking, and accessible More menu.
- Updated `product-manager/ui.css` with the exact navigation selectors sourced from PR #23 plus small Product Manager-scoped More-menu responsive rules. The full legacy core-ops adapter is deliberately not loaded because it overrides demo button styles; PR #23 retains ownership of that adapter.
- Available links reuse the PR #23 route mapping with the verified special-orders-test host and the explicitly labeled Consignment Beta domain. Destinations without verified launchers (Timeclock, Scanner, PO Companion, Split/Recall) appear as text without hyperlinks. Split / Recall is located in the Lightspeed Toolkit rather than a guessed standalone URL.
- Static checks: all 11 requested tool labels present; current-page link marked; existing grid and draft review element IDs retained; demo JS has no fetch/XMLHttpRequest; no extension or production modifications.
- Remaining: real browser screenshots, 100%/125%/200% zoom, keyboard/More-menu behavior, authenticated navigation, and cross-tool regression checks. The native `details` menu closes on selection/navigation; click-away refinement may follow browser review.
- Dependency: PR #23 and #16 remain draft/unmerged. PR #18 also remains draft/unmerged. Avoid merging before resolving overlapping shared-navigation changes.

## Consolidated refresh — 2026-10-28
- Old PR #18 has 17 changed files, including stale shared-ui library copies and assets. Replaced with clean draft PR #28 based on current consolidated branch; do not merge PR #18 wholesale.
- PR #24 remains draft; Product Manager UI uses its coordinated navigation patterns but neither imports nor overwrites that draft's shared compatibility adapter.
- Current consolidated has shared-ui/hc.css. Source-logo files were not found under shared-ui/assets on the consolidated branch during this review; interim accessible text wordmark is used rather than a broken image link. The approved original asset should be restored after its authoritative route is present.
- The refresh is demonstration-only. No live read adapter, employee PIN, product creation, approval, or write routes are in the Product Manager files.
- Added product-manager/ui-regression.test.mjs and .github/workflows/product-manager-ui.yml. CI results were not available at documentation time; do not treat tests as passed until GitHub Actions completes.
- Browser keyboard/zoom/responsive acceptance, auth restrictions in future live UI, and routing tests are pending.

## October 28 verification and gating
- Current PR #28 base compared to consolidated head at review. Product Manager-owned source from PR #18 is preserved in PR #28: index.html, ui.css, ui.mjs, validation.js, validation.test.js, INTEGRATION_PLAN.md, SHARED_UI_ADOPTION.md. PR #18 also carries outdated shared UI library/asset/CI copies; do not merge those. PR #18 is safe to close **as superseded** once reviewers acknowledge PR #28, without merging.
- CI GitHub Actions run 40724936577: Product Manager isolated UI tests **PASS** on PR #28's earlier head. Changes after that run require new CI evidence before merge.
- PR #24 owns current core navigation and web wordmark. Its `shared-ui/assets/hc-wordmark.webp` source asset exists on PR #24, but is **not yet on consolidated**, so the Product Manager must not point to an unavailable binary URL or copy older logos. Keep text fallback only until PR #24's shared asset/server route are merged and verified. Visual acceptance is BLOCKED on the approved original logo until that happens.
- Product Manager is still a standalone preview; no deployed authenticated route or live product API. **Before live read access**, reuse existing Timeclock-backed employee identity/session/active-status and the Special Orders / Scanner read-only product lookup gateway contract. Enforce permission server-side, with short-lived sessions, inactive employee denial, and fail-closed authorization; never create separate PIN or employee tables.
- New product create / matching must reuse scanner special-orders-adapter and SO product matching, duplicate SKU/UPC review, supplier resolution, and approved create path rather than a parallel write endpoint.
- Browser acceptance: this session has no runnable current-branch checkout for Chromium execution; screenshot, keyboard and 100/125/200% zoom verification remain **NOT VERIFIED**. Previous UI source/static checks are not substitutes.
- No production deployment; no Lightspeed writes. Employee-edit draft remains local and review-only. 
