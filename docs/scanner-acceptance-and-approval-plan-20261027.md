# Product Scanner — Consolidated Audit and Acceptance Plan
Date: 2026-10-27
Status: In Development (read-only safety improvements)

## Authoritative systems inspected
- Code: Tawgod/Lightspeed integration/hobby-corner-consolidation
- Extension: manifest v0.3.23, popup, page-capture.js, review.js, special-orders-adapter.js, completeness checks
- Backend: routes/scannerMatchGateway.js, routes/specialOrderProducts.js, services/scannerTimeclockGateway.js, scannerPreorderStaging.js, scannerSessions.js; Timeclock PIN and role resolution
- Tests: scannerAcdCapture, scannerReviewAutoMatch, scannerMatchGateway, scannerPreorderStaging, scannerSkuDefaults, scannerLightspeedRoles, scannerTimeclockAuth
- Active work: PR #12 Timeclock employee access; PR #11 Consignment; PO Companion branch feature/po-companion-consolidated-v2; product manager foundation; release queue
- Railway: environment includes services not all healthy; service-specific deployment health should be inspected before any deployment

## Findings and changes
1. **Remote duplicate fail-open risk:** Lightspeed remote matcher previously used Promise.allSettled then ignored failed requests, returning an empty or partial match set as a verified result. Updated it to search every unique identifier and require all requested searches to return valid result arrays. Failure now returns HTTP 502 and blocks any create proposal (the gateway requires both local and remote sources).
2. **Completeness merging:** When a local match was merged with a Lightspeed result, available UPC/description data was lost if the local record had blanks. Fixed field enrichment while preserving flags that distinguish missing vs unknown weight and picture. Added testable pure helper for UPC, weight (including 0 lb), picture.
3. **Current-page-only capture:** page-capture.js inspects only DOM/JSON-LD of the currently selected supplier tab and does not crawl catalog pages. The review previously warned when multiple Product JSON-LD objects existed but still let users proceed through lookups. It now blocks the draft when multiple products are detected, requiring an individual product page. No full-site crawling was added.
4. **Timeclock:** Consolidated backend checks PIN against Timeclock and reauthorizes employee before each scanner gateway operation; session token expires after 15 minutes. PR #12 proposes all active Timeclock employees can review/stage. It is not yet merged and must be reconciled separately. Verified Lightspeed Admin/Manager/Owner role selection is not yet live-accepted; no permission assumption is introduced.
5. **Supplier matching:** supplier list loaded from existing Special Orders suppliers table through authenticated scanner gateway, exact normalized match required; unmatched suppliers warned and blocked from new-item proposal. No supplier create/update operation.
6. **Preorder staging:** stored in separate scanner_preorder_staged_items with unique (campaign_id,item_key), PENDING_REVIEW, no live preorder_products promotion or Discord publication. A verified employee permission is required. Real inventory writes remain disabled.
7. **Controlled approval path:** next proposed steps are persistent employee review queue, immutable captured source fields and duplicate check results, server-side revalidation and idempotency before creating/updating one selected product. Do not enable Lightspeed writes yet.

## Browser/employee acceptance checklist (not performed)
1. Load unpacked extension from a deliberately tested, queue-reconciled build, confirm current active tab selected and single product capture. Try category/search pages; no new-item action must be possible.
2. On ACD single-product page confirm supplier reorder number -> General SKU, UPC, description, weight, and separately MAP/cost/MSRP; compare existing Lightspeed item and test preserved manual SKU edits.
3. Timeclock PIN: active employee read/authorization; inactive employee denial and expired session. For privileged operations verify exact live Lightspeed user response/role and review PR #12 role policy before merge.
4. Matching: existing SKU, UPC, supplier reorder number, fuzzy-name candidate, mismatched supplier, and no-result paths; simulate remote search failure and confirm **verification failed**, never no matches.
5. Completeness: existing records with missing UPC, zero/unknown weight, missing/unknown picture; confirm errors say missing vs not verified.
6. Preorder: stage two distinct products into one campaign, attempt repeat UPC, confirm only one pending record per key and no Discord post.
7. New-item: no matched existing product and both lookups verified; Create Item must show unsaved proposal, never update Lightspeed.
8. Review queue and controlled approval to be built/tested before any create/update; include audit and rollback/partial-failure handling.

## Release separation
No extension version bump, ZIP, Railway deployment or Chrome Web Store publication from this branch. Before packaging, reconcile Tawgod/Hobby-Corner main CHROME_EXTENSION_RELEASE_QUEUE.md, active extension branches/PRs, and consolidated extension source. Test status ≠ browser acceptance or deployment.
