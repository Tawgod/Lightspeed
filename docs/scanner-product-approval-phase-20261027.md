# Product Scanner — Product Review Inbox Foundation
Date: October 27, 2026
Status: In Development. Neither merged nor deployed.

## Scope implemented
- New separate `scanner_product_review_proposals` table initialized when the authenticated scanner gateway starts.
- Proposal draft contains supplier ID, immutable JSON snapshot of employee-reviewed product fields, source product URL, employee ID, timestamp and `PENDING_REVIEW` state.
- An active scanner employee can submit a new-product proposal from the existing scanner review page only after successful browser matching and supplier selection; the server *independently reruns* both local and Lightspeed product matching before accepting the proposal.
- Duplicate identifiers per supplier are protected by `UNIQUE(supplier_id,item_key)` and `ON CONFLICT DO NOTHING`. Any upstream matched product returns a conflict rather than silently staging another new item.
- The scanner displays the inbox and shows submission status. Server endpoints support list, get-one and submit only. There is **no review promotion, approve, update, delete, Discord post, Lightspeed create or Lightspeed edit endpoint**.

## Required dependency (not yet merged)
- PR #14, `feature/scanner-duplicate-safety-review-20261027`, ensures remote Lightspeed matching returns HTTP 502 on partial/failing subqueries and protects single-product capture. The consolidated matching route currently uses `Promise.allSettled` and ignores failed subqueries, which can misreport no matching product. **Do not deploy this queue without PR #14's fail-closed matching guarantee.**
- PR #12 separately changes Timeclock scanner `canApprove` to all active Timeclock employees. This queue uses `canLookup` for proposal drafting/submission and has **no final approval privilege**. Do not interpret `canApprove` from PR #12 as authorization for future Lightspeed writes.
- PO Companion PR #13 and Consignment PR #11 are separate extension workstreams requiring shared release queue reconciliation prior to any package.

## Next phase: controlled review and final write authorization
1. Browser acceptance with real store employees: verify PIN, supplier match, exact/fuzzy existing product, source URL, new item submit, duplicate conflict and inbox.
2. Verify schema and table persistence on isolated beta/test environment; no production deploy performed.
3. Implement reviewer decisions through a separate user interface with verified final-write privilege policy and explicit human confirmation.
4. Re-run **live** duplicate checks within the final write transaction/control step. Detect same-product race, verify supplier mapping, validate request uniqueness, persist a write intent and audit; never retry blindly on uncertain Lightspeed responses.
5. Add rollback/partial-failure reconciliation, Lightspeed write test fixtures, idempotency and recovery plan; only then request production approval.

## Tests
- `tests/scannerProductReviewQueue.test.js` covers schema, active-employee submission, server lookup calls, duplicate rejection, failed backend lookup, invalid input, immutable duplicate proposal handling and absence of any approval/write endpoint.
- Scanner UI CI: GitHub Actions run `40539225636` succeeded. Browser and live Lightspeed tests remain outstanding.

## Release policy
No extension version bump, ZIP, Railway deployment or Chrome Web Store publishing from this branch. Update `CHROME_EXTENSION_RELEASE_QUEUE.md` and reconcile every extension PR before any extension release.
