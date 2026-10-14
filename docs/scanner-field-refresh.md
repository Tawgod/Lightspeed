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
