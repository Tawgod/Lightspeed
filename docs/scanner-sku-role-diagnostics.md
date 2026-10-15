# Scanner SKU default and role verification follow-up

Status: **In Development**, not merged, deployed or packaged into an extension release.

## General SKU behavior

- On scanning a supplier page, General SKU defaults to the supplier reorder number (if the page provides a supplier reorder number).
- General SKU remains editable. Editing supplier reorder number updates General SKU only while General SKU still holds the previous supplier default and the employee has not manually edited General SKU.
- When the automatic dual-source product lookup succeeds, only a **unique exact linked match** by UPC, supplier reorder number or SKU can supply the Lightspeed SKU. Fuzzy name-only matches must not silently overwrite the proposed General SKU.
- Any employee edits take precedence. No product write endpoint is enabled.

## PIN permission verification blocker

- The deployed scanner displayed "Lightspeed role could not be verified" for a user with an existing Timeclock PIN. This does not establish their actual Lightspeed role; no approval permissions were changed.
- Timeclock service variables named LIGHTSPEED_DOMAIN and LIGHTSPEED_TOKEN are configured (value and credential never disclosed).
- New stage-specific server log messages distinguish unsupported role shape, role catalog failure, and unavailable individual/legacy API lookups, without logging account identifiers, PINs or tokens.
- Lightspeed documented GET /api/2026-07/users/{user_id} requires users:read scope. Verify whether the configured Timeclock token can read employee roles, then verify the exact response structure in a secure diagnostic before changing role eligibility. Continue to deny authorization while unresolved.
- Existing scanner Admin/Manager automatic entitlement remains on the server. A hidden Lightspeed field is not needed because Timeclock has lightspeed_user_id.
- Do not merge/deploy role edits or grant special access without verifying actual user-role response and preserving fail-closed behavior.

## Validation

- Scanner UI GitHub Actions run 38752948241 succeeded.
- Added standalone regression test tests/scannerSkuDefaults.test.js for SKU behavior.
- Browser acceptance, Lightspeed role API compatibility verification and deployment remain pending.
