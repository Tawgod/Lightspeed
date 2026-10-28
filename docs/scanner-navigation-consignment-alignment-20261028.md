# Product Scanner — coordinated shared UI/navigation alignment
Date: 2026-10-28
Status: In Development; no merge, deployment or extension package

## Source verification
- Authoritative code: `Tawgod/Lightspeed:integration/hobby-corner-consolidation`.
- Shared foundation: PR #16, draft; scanner shared component work: PR #19, open, not merged.
- Core-ops navigation: PR #23, draft, `feature/core-ops-shared-navigation-20261027`; aligned exact core-route labels with this PR.
- Preferred visual reference: Consignment Manager beta PR #11 `feature/consignment-layout-foundation` (dark navy, original orange-and-blue wordmark, gray-blue visibly shaded surfaces).
- Current backend route declarations were inspected: `/special-orders`, `/ordering`, `/preorders`, `/gw-preorders`, plus extension-owned `product-scanner/review.html` and `popup.html`.
- Other extension work: PR #22 Timeclock/Split Recall host overlays, PR #13 PO Companion draft. They are independent and not yet included.

## Implemented screens
- **Scanner review window:** namespaced reusable shared HC panel, inset, button and form styling reconciled from PR #19; common dark nav with active Product Scanner highlight, a More menu for secondary routes, correct keyboard Escape handling and visible focus, shared exact-plaintext clipboard copy.
- **Chrome Toolkit popup:** identical shared navigation contract, current Toolkit highlight and compact More menu; pre-existing invoice detection, supplier scan, Split/Recall actions and order/PO context preserved.
- **Visual treatment:** the existing approved original wordmark, dark navy header and gray-blue shaded panels from the scanner beta remain in place. Navigation CSS is a small extension adapter over the same shared tokens, not a new theme.

## Linked destinations and verified contract
- Backend routes /special-orders, /ordering, /preorders, /gw-preorders are declared in consolidated server.js and labels match PR #23. Their host is the currently configured Lightspeed API service hostname.
- Product Scanner and Lightspeed Toolkit use chrome.runtime.getURL for bundled extension HTML pages.
- No broken placeholder destinations: Timeclock, Product Manager, PO Companion, Consignment Manager and Split/Recall have no verified standalone stable *browser URL* in this extension environment; Timeclock and Split/Recall retain their existing embedded launchers/actions, while incomplete or beta-only URLs are not misrepresented as production destinations.
- No untested beta Consignment URL, new permissions, or speculative routing was added. Extension launchers may be added after their owner workstream verifies a stable supported deep link.

## Tests
- GitHub Actions scanner UI run 40719605947 PASS (includes scannerSharedNavigation.test.mjs).
- Verified by static tests: consistent route labels and IDs, nav links/current-page semantics, More menu/Escape-to-focus, preserved existing scanner/product controls, disabled create preview, shared copy helper and extension-local links.
- Still pending actual Chrome screenshot comparison before/after, 100/125/200% zoom, keyboard-only browser flow and PIN authentication, external service availability/click-through and employee acceptance.
- Live web HTTP URL inspection was unavailable from tool environment; declared server routes do not prove external reachability.

## Safety & release
- No application/business logic/API contract changes, employee-identity alteration, product write permission, production deployment, extension version bump or ZIP packaging.
- Before release reconcile the shared queue plus PR #16/#19/#23/#22/#13/#11 and release branch; browser-validate URLs and visual accessibility.
