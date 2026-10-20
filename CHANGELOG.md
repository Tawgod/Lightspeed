# Changelog

## 2026-10-19 — Consignment beta (feature branch only)
- Created isolated standalone Consignment Manager beta, linked from Special Orders.
- Added sample multi-item submission, online-submission review matches, approval, aging, status and simulated credits, and sample customer portal.
- Reused scanner match-normalization module; added no-write bridge using the existing scanner/Special Orders local and remote matching endpoints.
- Added safe product preview for the existing Special Orders create contract with original images/inventory/UPC/supplier/cost excluded.
- Added initial database schema and credit-event structures, not applied or deployed to production.
- Added lightweight extension popup launcher; entry queued in Hobby Corner's shared extension release queue, not packaged or published.
- Deployed a synthetic-data test build to isolated Hobby Corner Integration Test Railway project; no production Lightspeed, credit, customer or product writes.
- GitHub Actions smoke tests and scanner regression tests provided for branch checks.

Known limitations: live Lightspeed matching, staff permissions, actual customer portal SSO, database persistence, product writes, point-of-sale sale reconciliation and store-credit posting are not connected in the review beta.