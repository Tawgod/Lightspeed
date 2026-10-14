# Product Scanner v0.3.22 — employee review / automatic verification

Status: **In Development**. Not merged or deployed. Base: `Tawgod/Lightspeed:integration/hobby-corner-consolidation`; branch: `feature/scanner-review-auto-lookup`.

## Review flow

- A supplier-page scan immediately fills product fields. After the employee signs in using Timeclock PIN, the scanner automatically invokes the existing dual-source (local + Lightspeed) product matching gateway. Scanning another page triggers a new match without requiring the old Check Existing Products action.
- Edits invalidate any prior no-match verification and queue a fresh check. Backend is still read-only, authenticated and gated; the Create Item action is only a **proposal** after both lookups succeed with no matches **and** the supplier is recognized.
- Employee login is condensed into the header. Raw supplier JSON/HTML and internal product ID fields are removed.
- Matches display product title, SKU, description, and missing UPC, Weight and Picture flags **only where the upstream source provided enough detail**. Missing weight/image metadata in local-only matching is reported as *Not verified*, not falsely as *Missing*. No internal UUID is shown.
- New-item supplier suggestion is validated against the active supplier list in the existing Special Orders database through `GET /api/scanner/suppliers`. ACD website aliases `ACD Distribution` and `ACD` are handled with exact normalization and ambiguity safeguards. No exact supplier match triggers a warning; employee may select or edit supplier from the list. No new supplier is automatically written.
- Product duplicate checks search **all** supplier associations to avoid missing items carried by another distributor.
- The former supplier advertised-price field is now explicitly **MAP**; extraction fills it **only** from supplier metadata or a field labeled MAP. ACD's displayed selling/cost price is not assumed to be MAP. Future eCommerce MAP price-floor enforcement needs a separate policy and data model (effective dates, exceptions, channel price checks) and is **not implemented**.

## Permission investigation

- Live Railway Timeclock logs preceding this change recorded repeated `Lightspeed role lookup unavailable; automatic approval withheld` errors. This supports role lookup failure as the cause of persistent read-only scanner status, but does not identify which particular user/PIN was affected.
- Timeclock now attempts the documented read-only `GET /api/2026-07/users/{user_id}` using the employee's linked `lightspeed_user_id`, then falls back to the older user-list/role lookup path. Unknown/inactive/mismatched or inaccessible roles still fail closed.
- Timeclock returns only a non-sensitive diagnostic reason; scanner header explains `Lightspeed account not linked`, `role not recognized`, `Lightspeed lookup unavailable` or `role read-only`. No PIN, employee ID or bearer token is shown.
- Verified Admin/Manager approval **eligibility** remains separate from product creation. No product create/update endpoints were added, and no employee permissions were modified.
- Source of role permissions: Lightspeed X-Series `users:read` API. A successful API call and exact role mapping for an actual Manager still needs verification in Railway.

## Testing and rollout

- GitHub Action scanner UI, ACD/MAP capture, role and matching regression tests: see `Scanner review UI regression` workflow in branch.
- Unpacked Chrome preview: `Package Scanner Unpacked Preview` workflow, artifact named `Hobby-Corner-Scanner-v0.3.22-unpacked-preview`.
- Browser acceptance needed: Manager PIN diagnostics, ACD auto UPC lookup, second page scan while signed in, no-match Create Item proposal, supplier exact and unmatched cases, weight/picture completeness flags.
- **No merge, Railway deploy or Chrome Web Store publication has been carried out for this version.** Backend changes and role fix will not affect deployed PIN behavior until authorized rollout.
