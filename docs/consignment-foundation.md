# Consignment foundation (2026-10-19)

Status: In Development; interactive synthetic-data beta deployed in isolated Railway test project. No production POS or customer/credit API writes.

Repository: Tawgod/Lightspeed
Base: integration/hobby-corner-consolidation
Feature branch: feature/consignment-layout-foundation

## Agreed layout
- Standalone management UI alongside existing Special Orders, with navigation links both ways once routed.
- Chrome extension is only a lightweight launcher/status entry point; do not embed a full consignment manager inside content scripts.
- Customer portal will show submissions, item status, sales, and credits after secure identity integration.
- Existing Lightspeed customer UUID is the customer reference; do not equate POS customer records with web-store sign-on sessions.
- Reusing the Lightspeed Online login requires verifying supported SSO/OAuth/delegated identity or a supported identity handoff. Do not collect or store Lightspeed passwords, scrape session cookies, or claim customer login compatibility without provider support.
- All consignment products use the dedicated category General > Consignment. Resolve and validate the actual category UUID before writes; never silently create a different category.
- Unique consignment item IDs (e.g., UG-001284), no recycled primary SKU. Prefix display name with USED — and preserve a dedicated used flag/identity in the ledger.
- If matching an existing/historical new product, offer an explicit source selection with product UUID. Copy only curated informational fields (e.g. brand, descriptive specifications) after review. NEVER copy images, stock, UPC/barcode, supplier-cost fields, original product SKU, or supplier reorder settings. Do not accidentally associate the used item with new stock.
- New used item listing defaults in-store only. Online enablement requires staff opt-in and channel validation, plus unique photos or no photos rather than copied pictures.
- A submission includes multiple independently approved items; rules, inspection fields and terms differ by Game, Puzzle, RC and other.
- Hold three full days from verified POS sale before exactly-once credit to the consignor; differentiate RC no-return agreement from Game/Puzzle return windows.
- Age, quantity limits, warnings, price-change approvals, customer credits and audit trail live server-side and cannot rely on the extension.
- Staff roles and login must be verified before any private customer information is exposed. No public operational endpoints.

## Layout preview
- consignment-layout.html is standalone static developer preview. It has no real data and intentionally makes no API writes.
- Pending integration: route /consignment, add navigation link to /special-orders, add light extension launcher through coordinated release queue.
- Release queue review REQUIRED before any extension release. This branch makes no extension code changes.

## Next
1. Inspect backend authorization model and special-orders hosting; choose a secure staff route.
2. Verify vendor documentation and Lightspeed Online identity options, POS account credit API, product variant/metadata and online listing APIs before customer portal or financial writes.
3. Create SQL schema, auditable lifecycle, sample fixtures, API and staff UI wired to test database.
4. Add explicit existing-product lookup and curated copying with image omission; duplicate SKU protection.
5. Request staff feedback on layout, then queue extension launcher in CHROME_EXTENSION_RELEASE_QUEUE.md and coordinate next extension release.
6. Confirm business policy for store credit reversal if a POS transaction is voided or refunded after credit posting.

## Development progress (2026-10-19, phase 2)
- Added GET /consignment standalone preview route to server.js and Special Orders toolbar link.
- Added db/consignment_schema.sql (NOT automatically initialized or deployed): consignors, submissions, reusable product templates, individual items, credit ledger, event history.
- Added online-submission match review explanation to UI; matching is not connected yet.
- Decision: one unique physical consignment item and unique Lightspeed SKU per accepted copy. Never reactivate an already credited physical-item SKU. Reuse a template/product match instead; when sold and credit reconciled, deactivate the sold item's Lightspeed product, subject to return/refund and online-listing safety checks.
- Matching should run for staff entries AND customer-submitted online items when staff opens the pending submission, searching active and inactive/historical NEW products, without automatically accepting matches. Product photos are excluded from copying.
- Security: schema is not a public API. Any staff/customer list and matching details require authorization. The static preview displays no real records.
- Outstanding: implement protected list/search endpoints and a candidate-match scorer; verify Lightspeed inactive product API before enabling writes; integrate authenticated customer portal; implement extension launcher only after release-queue reconciliation.

## Review beta delivery — 2026-10-19
- URL: https://consignment-beta-test.up.railway.app/consignment
- Railway: Hobby Corner Integration Test project, test environment, service consignment-beta; deployed from feature/consignment-layout-foundation. Never repoint production Special Orders for this beta.
- Main route /consignment serves the interactive demo. Static client JS and CSS plus shared match-utils module are served by Express.
- Demo data stored in browser localStorage, synthetic examples only. No server-side storage or real multi-user collaboration. Reset sample data is available.
- Staff: filter/search, review suggested matches for online and staff submissions, select templates, approve/reject, change price/condition, simulate sale, enforce 72-hour hold before simulated credit, aging warnings.
- Customer portal: sample issued and pending credit history, not actual Lightspeed available balance. Identity/SSO not implemented.
- Existing scanner match normalization reused. services/consignmentMatcher.js calls the existing scanner checkProductMatches for future authenticated integrations and fails closed if either source fails. Live matching is NOT enabled in the isolated beta.
- services/consignmentProductPreview.js maps to safe subset of the existing Special Orders product-create contract; excludes original pictures, SKU, UPC, inventory, supplier and reorder data, and requires a verified category UUID. Cost-accounting treatment remains an approval gate.
- Extension popup launcher added to feature branch and recorded in Tawgod/Hobby-Corner:main/CHROME_EXTENSION_RELEASE_QUEUE.md. No package or version bump.
- Smoke tests: node --test tests/consignment-beta.test.mjs, GitHub Actions consignment-beta-smoke.yml and scanner regression CI.
- Known limitations: browser rendering cannot be independently confirmed by assistant; no real customer auth, persistence, payment credits, product writes, labels, online listing or SSO.

## Next implementation milestones
1. Validate beta user experience with store staff.
2. Build protected staff APIs and isolated Postgres persistence with auditable event history.
3. Connect authenticated Special Orders local+remote matching to online submissions; include inactive/historical original new products.
4. Verify actual General > Consignment category UUID and accounting cost policy before any product write.
5. Implement safe product creation, unique used SKU, sales reconciliation, three-day hold and exactly-once credit with return safeguards.
6. Verify supported Lightspeed Online single-sign-on, not direct password reuse or cookie scraping.
7. Release Chrome launcher only after queue reconciliation and test approval.

## Customer-first intake beta revision — 2026-10-20
- Customer preview URL: /consignment/submit (same isolated beta host). Separate form from staff management; no backend submission writes or production customer records.
- Games and Puzzles presented first. Game/Puzzle/RC/Train/Other condition labels and type-specific explanations available in services/consignmentFormRules.js; descriptions derived from existing printed forms and simplified in the UI.
- Required customer fields: name, phone, email, per-item type, title, price, condition, missing-components declaration and details when missing, smoking household, pets (Cat/Dog/Other/None), musty/basement smell. Multiple items per submission.
- Mechanical fields for RC and Train: brand/manufacturer, model/part number, tested and testing comments, motor type brushed/brushless; Train additionally DC/DCC/Unknown and N/HO/O/G/Other scale.
- Contact preferences: email, SMS/Klaviyo, Discord if linked. Beta records neither consents nor sends notifications. Actual marketing/transactional permissions and integration still need separate design.
- Staff approval queue: customer name click filter, select many pending items, bulk approval simulation. No actual POS create, tag, or credit actions.
- Customer matching: do not automatically create customers based only on an unverified contact name. Use existing Lightspeed customer lookup and require employee confirmation for ambiguous/new records. Avoid duplicate records.
- Safety: actual customer registration, durable submissions, verified terms, digital signature, privacy, authenticated login, tag creation and credit messaging are not implemented; do not ask customers to use public beta for real data.
- Next: shared protected persistence across customer and staff UIs, customer record matching queue, customer form agreement/signature, detailed employee checklist, permissions and audit log, verified Klaviyo transactional SMS/email support and Discord link.
## Protected persistence / reconciliation foundation — 2026-10-27
- New routes/consignmentBeta.js mounted only at /api/consignment-beta. Endpoints: GET health, GET submissions, GET submission items, POST staff submission, POST item review, POST item matches.
- Every endpoint requires x-consignment-staff-key checked using a timing-safe digest comparison. Unless CONSIGNMENT_BETA_DATABASE_URL and CONSIGNMENT_BETA_STAFF_KEY are both configured, all endpoints return 503. No public customer submission writes or public list APIs.
- A separate CONSIGNMENT_BETA_DATABASE_URL is intentionally required; never silently use production DATABASE_URL. Schema db/consignment_schema.sql must be reviewed and applied manually only to an isolated test database.
- POST changes require CONSIGNMENT_BETA_ALLOW_DB_WRITES=true and remain restricted to isolated consignment records, NOT Lightspeed products/customers/credits. Default is locked (423).
- Submission insert is transactional. New customer records are marked for POS identity review, not automatically synchronized. Individual consignment codes are unique, and inspection information is saved in JSONB.
- Read-only match endpoint calls services/consignmentMatcher.js when an authenticated lookup is injected; no gateway is configured in the test beta yet. Existing scanner/Special Orders adapter requires both local and remote match checks to succeed.
- services/consignmentCreditEligibility.js is a pure, no-write safety planner: exact 72-hour hold, verified sale identity, complete reconciliation, no reversed/pending returns, integer-cent credit calculation, stable idempotency key. There is no job or API capable of posting a credit.
- Tests: tests/consignment-api.test.mjs and tests/consignment-credit.test.mjs with GitHub Actions smoke workflow. These test fail-closed behavior, required disclosures and eligibility boundaries.
- Outstanding: isolate and provision actual test Postgres before activating persistence; employee identity/role authorization beyond the beta shared key; secure customer login/public intake; product/customer matching against real retailer; verified category/accounting and duplicate-safe product creation; sales/returns event ingestion and credit reconciliation.
- Do not reuse the staff beta key as a customer authentication mechanism. The public form remains sample-only and disconnected.

## UI guideline alignment — 2026-10-27
- Staff and customer beta share the same updated design tokens through consignment-beta.css.
- Uses layered blue-gray surfaces and shaded section headers instead of large flat white panels; stronger visual separation between dashboard, item list, detail pane and form groups.
- More consistent accent buttons, navigation active states, table striping, interactive selection, and visible keyboard focus.
- Mobile layout remains responsive; customer-facing form and staff page both use the shared stylesheet.
- UI-only changes: no alteration of customer data, Lightspeed product writes, credit posting, or extension packaging. Automated smoke and scanner regression tests passed on UI stylesheet commit 7af949b20cc45eb660e0089ec16ccc31759458c0. Manual visual review pending.
