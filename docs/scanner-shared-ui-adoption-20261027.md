# Product Scanner — Shared UI / UX beta adoption, 2026-10-27

Status: **In Development**. The changes on this branch are **not merged, deployed or extension-packaged**.

## Source and scope
- Authoritative application base: `integration/hobby-corner-consolidation`; current scanner v0.3.25 beta work previously merged as PR #17.
- Shared UI foundation: `feature/shared-addon-ui-beta-foundation-20261027`, draft PR #16. Adopted the published-on-branch namespaced `hc-* ` component conventions and copied `shared-ui/clipboard.mjs` verbatim to `extension/shared-ui/clipboard.mjs` so it can be included in extension packages.
- Design contract: `Tawgod/Hobby-Corner:main/SHARED_ADDON_UI_UX.md`.
- Existing approved styling: `extension/product-scanner/hc-beta.css` includes the shared `hc.css` tokens and scanner scoped adoption layer; `extension/popup-beta.css` already applies the navy/blue palette to the popup, with original wordmark in the extension.
- Current changes: `extension/product-scanner/review.html` adds shared `hc-panel`, `hc-inset`, `hc-button`, `hc-select`, `hc-input`, `hc-textarea`, and accessible status/alert classes to existing controls. `extension/product-scanner/review.js` uses `copyHobbyCornerField` without trimming, parsing or altering the JSON source.
- Existing IDs, JS handlers, routes, authentication, scanner captures and approvals remain unchanged. No Lightpeed product writes enabled or modified.

## Differences from generic foundation
- Scanner uses a two-column layout at larger browser widths instead of the shared navigation shell because this is an extension review window; preserving existing workflow/element IDs avoids breaking supplier and match review interactions.
- Toolbar popup retains its 390px task-first layout. Shared styling was already adopted previously; no additional popup behavior change in this PR.
- The copy action emits the existing JSON representation with the shared helper, which preserves exact field values including leading zeros and description line breaks. Rich HTML export is not enabled because this control copies product data, not a rendered rich-description editor; the helper supports rich HTML for future explicitly approved workflows.

## Testing and acceptance
- Automated: `tests/scannerSharedUiAdoption.test.js` checks shared class use, existing IDs, brand, exact copy of whitespace/leading zero identifiers, and no live write calls. Scanner UI workflow runs the new test alongside existing authentication, matching and staging checks.
- Still required before extension release: actual Chrome keyboard-only traversal, 100/125/200% browser zoom, focus states and high-contrast review, employee PIN and expired session, ACD individual product scan vs multi-product listing page, preorder staging, duplicate detection, proposal submit, copy into target apps with formatted descriptions.
- Auth blocker from earlier Railway startup logs: scanner service reported missing/empty `SCANNER_SERVICE_SECRET` despite the variable name being present. UI change does not fix this backend issue.
- Do not package/release or deploy without separate approval; reconcile open PO Companion PR #13, Consignment PR #11 and foundation PR #16 in `CHROME_EXTENSION_RELEASE_QUEUE.md` before next release.
