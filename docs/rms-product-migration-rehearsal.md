# RMS Product Migration Rehearsal

Status: Testing

Branch: `feature/rms-product-migration-rehearsal`
Base: `integration/hobby-corner-consolidation`

## Purpose

Stage the validated RMS -> Lightspeed product migration workflow for a larger controlled rehearsal without changing the production Railway deployment.

The proven migration implementation currently lives in `Tawgod/Hobby-Corner-Discord-Bot:product-migration-colab` under `migration/product_migration`. The operational mapping and test-result workbook is the live Google Sheet `LS: importer`.

## Verified live-sheet state (2026-10-16)

### Cleanup / name / description verification

`Migration Cleanup Results` currently contains 50 evaluated products:

- 48 `VERIFIED`
- 1 `REVIEW`: `SB76054` because the expected image file is missing
- 1 `MISSING_LIGHTSPEED_IDS`: `EST1602`

For verified rows, the cleanup read-back confirms product name and long-description persistence.

The current migration naming behavior prefers RMS/legacy Web Description when present and otherwise falls back to RMS Description.

### Image verification

`Migration Image Repair Results` currently contains 50 evaluated products:

- 37 `ALREADY_HAS_IMAGE` with image read-back verified
- 12 `MISSING_IMAGE_FILE`
- 1 `SKIPPED_NO_PRODUCT_ID`

Low-resolution images are flagged `poor_quality_image` for later replacement but are not treated as migration-write failures when an image is present and readable.

### Reorder verification

`Migration Reorder Test Results` currently contains 28 rows and all 28 are `VERIFIED`.

Validated behavior:

- Lightspeed reorder method is `MIN_MAX`
- RMS proposed reorder point maps to Lightspeed minimum
- RMS proposed restock level maps to Lightspeed target
- zero minimum values are supported
- inventory remained unchanged in every verified reorder test

## Required safety boundaries

- Never import RMS on-hand quantity as Lightspeed opening inventory.
- Opening inventory is established only by the physical inventory process after catalog migration.
- Keep a hard batch-size limit for controlled rehearsals.
- Block payloads that contain outlet/on-hand inventory write fields.
- Preserve duplicate detection / skip-existing behavior.
- Do not create or update products when required supplier/category mappings are unresolved.
- Image problems should be logged separately from core product-write success.
- Do not deploy this branch to production Railway services without explicit authorization.

## Remaining controlled-test exceptions

- `SB76054`: product data is verified; image source file is missing. Keep in review until an acceptable source image is supplied or explicitly waived.
- `EST1602`: no Lightspeed product/family IDs were available during cleanup. Reconcile the product identity before including it in a write/update rehearsal.
- Other rows with `missing_image` or `poor_quality_image` remain image-cleanup work but do not invalidate the verified core write path.

## Next rehearsal gate

1. Port or invoke the proven write path from `Hobby-Corner-Discord-Bot:product-migration-colab` without changing its safety rules.
2. Select a larger varied rehearsal batch from READY products while excluding unresolved IDs/mappings.
3. Run dry-run payload validation first.
4. Run a bounded live rehearsal only after explicit authorization.
5. Verify name, long description, identifiers, supplier, category, cost, retail, reorder configuration, image state, and unchanged inventory by read-back.
6. Record the run in `LS: importer` with a distinct run ID.
7. Do not repoint or deploy production Railway services as part of the rehearsal branch.
