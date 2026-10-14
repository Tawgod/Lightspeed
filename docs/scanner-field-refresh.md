# Scanner field refresh — pre-publication beta

Status: **In Development**. UI updated and automated source checks passed; browser and live matching acceptance testing still outstanding. Do not merge or publish until tested.

Source branch: `feature/scanner-fields-create-preview` from `integration/hobby-corner-consolidation`.
Extension development version: `0.3.20`.

## Fields

- **General SKU (Lightspeed)** is a distinct employee-confirmed value; it must not be assumed to be the supplier SKU.
- **Supplier reorder number** is captured from supplier structured-data `Product.sku` when provided. A supplier association is required before this number is persisted to a supplier-specific Lightspeed record. Do not treat it as globally unique.
- **UPC / GTIN** is captured from supplier schema.org product fields (`gtin8`, `gtin12`, `gtin13`, `gtin14`, `gtin`, `upc`), and common structured meta/itemprop fields. Capture is conservative: only numeric 8/12/13/14 digit values; otherwise leave blank and warn for human correction. This does not guarantee extraction from every supplier's custom page layout. Test against an example page on which UPC was missed.
- Removed Currency and Manufacturer Part Number from editor and prepared creation payload. Brand, image reference, advertised price and description remain informational, not automatically promoted to Lightspeed prices.

## Create Item preview

- UI action: **Prepare Create Item**.
- Disabled until employee has signed in and both local/remote duplicate lookup services successfully return zero matches.
- Invalidates eligibility on field edits; rechecks needed.
- Shows a proposed payload in the review window. **No product creation/updates, authorization for writing, or backend write endpoints were added.**
- Follow-on development: authorized Timeclock approval endpoint, final duplicate recheck immediately before writes, supplier-product association validation, and idempotent/transactional create workflow.
- The Chrome Web Store package remains on a separate `feature/chrome-web-store-release` branch. Do not publish the existing 0.3.19 package as though it contained these scanner improvements.

## Verification

- GitHub Actions: https://github.com/Tawgod/Lightspeed/actions/runs/38597687416 (JavaScript syntax checks and UI guard assertions passed).
- Remaining acceptance: capture real supplier SKU and UPC; verify exact general SKU/supplier reorder distinction, authorized Timeclock sign-in, matched/unmatched cases, edit-invalidates-review, and browser popup behavior. Approval remains disabled.

## ACD Distribution page example (2026-10-14)

Based on supplied screenshot: "Mechs vs. Minions: Bandle City Edition" on `acdd.com`. Expected values from visible details:
- Supplier reorder number: `IDRAYA4102100EN`, not a general Lightspeed SKU.
- UPC / GTIN: `850052382605`. Preserve string formatting and leading zeroes when present.
- Manufacturer: Incredible Dream.
- Supplier displayed price: `$41.24` (reference only; price/discount interpretation must be confirmed before storing as Lightspeed cost).
- MSRP: `$74.99`.
- Category: Preorder. Display as supplier status / informational warning, not proof of available stock.
- Weight: optional; when present, capture numerical value with original units rather than guessing or converting.
- General SKU: blank for user confirmation; do not infer from supplier reorder number.

ACD-specific fallback reads visible `SKU:`, `UPC:`, `Manufacturer:`, `MSRP:`, `Weight:` and `Category:` labels when structured metadata is incomplete. Handles multiple fields on one line. Other supplier sites continue using existing schema.org extraction, without reusing ACD-specific field selectors.

GitHub Actions fixture test: https://github.com/Tawgod/Lightspeed/actions/runs/38598715417 (**passed**, including ACD SKU/UPC, inline MSRP, weight, invalid UPC rejection, unrelated supplier isolation and generic GTIN).
Still needed: test the extension on a live ACD product page in Chrome to verify the site's actual DOM text and authenticated review window; if a detail does not populate, capture that page's visible DOM structure and refine extractor. No deployment or product write permitted by this change.

## Supplier snapshot reference and proposed supplier defaults (2026-10-14)

**Status: In Development, read-only preview only.** The scanner popup has a collapsed **Supplier snapshot (optional)** setting. If selected, scanning the active supplier tab captures the *visible tab* through Chrome's `captureVisibleTab` permission, resizes it to at most 900 × 650 pixels, and saves one JPEG per supplier domain in `chrome.storage.local` (up to eight domain snapshots per browser profile). No screenshot leaves the browser. Capture is explicit; employees should avoid pages displaying customer, account or employee information.

The scanner review window has a collapsed **Supplier snapshot / template reference** section where an employee can view an existing snapshot, manually upload a JPG/PNG/WebP screenshot (resized and converted locally), or delete it. These are **reference images**, not executable extraction templates. They do not train a model or automatically change supplier field mappings.

**Supplier default behavior:** The review window suggests a supplier name from known page metadata (e.g., `ACD Distribution`) or, when no supplier name is known, the supplier website domain. Employees can change it before preparing a new item. The suggestion is included in the **Prepare Create Item** proposal only after both local and remote product match services succeed and return zero matches. Any edits to the supplier invalidate the duplicate-check result and require a recheck.

**Existing supplier verification is still required**: A domain-derived suggestion does **not** prove the supplier exists or is unique in the supplier database; this preview does not create suppliers or products automatically. Before enabling a future create endpoint, add an authenticated server-side supplier lookup resolving name, website/domain aliases and existing Lightspeed supplier IDs, with a conflict/ambiguity selection interface. Only after confirmation should a new supplier be created, and it must be deduplicated/idempotent.

**Shared templates later:** For other store PCs to use the same snapshot or supplier-specific extraction selectors, add an approved Railway-backed template registry with role-gated uploads, explicit screenshot retention/deletion, size limits, and no sensitive account/customer data. A screenshot by itself is a human reference; field extraction rules should be confirmed on real DOM data before activation.

Testing: GitHub Actions `38599555517` scanner UI and `38599555479` unpacked extension preview both passed. Browser acceptance and shared-template storage remain outstanding. No Railway production config, Lightspeed supplier or product records changed.

## Lightspeed roles and shared template groundwork (2026-10-14)

**Native roles:** Lightspeed X-Series distinguishes Admin, Manager, Cashier and configurable roles; Managers generally have product-editing rights, while Cashiers do not. The current backend uses a retailer-level Lightspeed API credential, **not** a verified Lightspeed identity corresponding to the employee's Timeclock PIN. Never translate that API credential's scopes to an employee's edit authority. We have not established an authoritative staff role/permission endpoint or verified Timeclock-to-Lightspeed employee ID mapping. Scanner remains per-employee Timeclock `scanner_can_lookup`/`scanner_can_approve` until verified role sync is built and approved. Permissions must be evaluated server-side before every future write, with default-deny on missing/stale identity; allow explicit administrator overrides with audit logging. Product writes remain disabled.

**Shared supplier template registry:** Added `services/scannerSupplierTemplates.js` and `tests/scannerSupplierTemplates.test.js` to `feature/scanner-fields-create-preview`.
- Dedicated PostgreSQL `scanner_supplier_templates` table; domain identity, supplier display name, capped JPEG snapshot, reference selectors (JSON), `REFERENCE` vs `REVIEWED`, editor ID and timestamps.
- Read endpoints for authenticated scanner users, write endpoint requiring `canApprove`. Uploads validate domain, supplier name, image type/size, and selector field names. All writes stay `REFERENCE` (never automatically active scraping templates).
- **Not mounted on the running scanner gateway, no database migration run, no shared images uploaded, no production deployment.** Backend is an inert foundation pending separate authenticated integration, screenshot governance/retention design, proper staff mapping, and browser UI read/write wiring.
- Node API tests executed in GitHub Actions run `38600156022` with successful result, including read-only rejection and approved-user reference-write behavior.
- The current Chrome preview still saves optional supplier screenshots **locally to each PC only**. It can be tested now without waiting for shared template rollout.

Next: inspect Lightspeed staff API capability and employee identifiers in a read-only integration test; establish reliable employee mapping and permission refresh, introduce authenticated supplier search with existing supplier IDs, then wire shared templates and choose authorization policy for template editors. Keep write flags disabled until approved.

## Lightspeed-linked automatic scanner permissions (2026-10-14)

**Decision:** All verified native Lightspeed **Admin and Manager** users (also Account Owner) receive scanner approval entitlement automatically. Cashiers and unknown/custom roles do not receive automatic approval. Existing explicit, audited Timeclock `scanner_can_approve` grants remain independent. Active employees still need `scanner_can_lookup` and a valid Timeclock PIN.

**Existing link used:** `timeclock.employees.lightspeed_user_id`, already populated by existing Lightspeed user synchronization. No hidden custom field has been created or is necessary for the normal case.

**Code:** `timeclock/scannerLightspeedRoles.js` implements conservative ID-based role resolution. `timeclock/server.js` resolves the role against the existing server-side Lightspeed `/api/2.0/users` fetch for both scanner PIN verification and session reauthorization. No role field or secret from the Chrome browser is accepted. Automatic approval is denied if the link is absent, user is inactive, ID is missing/ambiguous, Lightspeed is unavailable, or role is not a recognizable native role. Role checks do not write to Lightspeed.

**Important acceptance caveat:** Actual Lightspeed users API role-property shape for Hobby Corner has not been confirmed from a sanitized response. Resolver currently supports a named `role`, `user_role`, `role_name` or `roleName`. If Lightspeed returns numeric role IDs, approval remains denied until a vetted role ID->name mapping is implemented. Product role permissions may also be customized; before writes, confirm any relevant detailed product permission flags for the assigned role rather than assuming the role alone is sufficient.

**Permission semantics:** `canApprove` in scanner session indicates eligibility for future approval; Create Item still generates only an unsaved proposal and no Lightspeed write endpoints are enabled. Revoking an explicit Timeclock grant does not override native Admin/Manager entitlement, per the automatic-roles decision; for full scanner denial, an administrator can revoke `scanner_can_lookup`, which also blocks approval.

**Testing:** `tests/scannerLightspeedRoles.test.js` verifies Admin/Manager/Owner allow, Cashier/custom/inactive deny, name-only and duplicate ID deny, and missing or malformed role deny. GitHub Actions `38600826210` passed. Live PIN-to-Lightspeed role mapping has not been verified; no Railway deployment or Web Store submission.

**Next:** Verify actual sanitized role schema from Lightspeed, exercise an authorized Manager PIN, a Cashier PIN, role revocation/unknown schema handling, then approve merge/release. No extra hidden Lightspeed field required unless the existing ID mapping is demonstrably absent.
