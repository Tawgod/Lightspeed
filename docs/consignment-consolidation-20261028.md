# Consignment selective reconciliation — October 28, 2026

Status: In Development; new consolidated integration is not deployed.
Authoritative base: integration/hobby-corner-consolidation (at review baseline 24e9834a6).
Original feature: feature/consignment-layout-foundation / draft PR #11 (75 commits behind).
Navigation child: feature/consignment-shared-nav-20261028 / draft PR #25.
Coordinated core operations: draft PR #24 (navigation contract supersedes PR #23).
New integration: feature/consignment-consolidated-v2-20261028 / draft PR #30.

## Selective port
- Original consignment staff and customer HTML, CSS, JS, initial schema and no-write matching/credit modules.
- Scoped UI compatibility styles and original-branding CSS. Reuses consolidated shared-ui/hc.css; never replaces it.
- Server.js only gained /consignment, /consignment/submit and their static asset routes, plus isolated staff API.
- Did not carry forward older special-orders.html, extension/popup.html, or whole server.js. Shared popup/navigation ownership stays on consolidated code.
- Staff API fails closed without CONSIGNMENT_BETA_DATABASE_URL and CONSIGNMENT_BETA_STAFF_KEY; test DB writes require CONSIGNMENT_BETA_ALLOW_DB_WRITES=true. No live Lightspeed customer/product/credit writes.
- PR #24 contract: core links to Special Orders, Ordering, Preorder Campaigns and GW Preorders; Consignment beta and Toolkit accessible. Consignment keeps the same verified destination list on its test pages. Full core header layout refinement and additional verified tool links remain shared-navigation team's responsibility.
- Original store wordmark is embedded as a source-preserving data URI in the beta HTML and styling. This avoids assuming binary asset deployment routes.
- Browser localStorage remains synthetic and is never synced with live customer data.

## Validation
- GitHub Actions: consignment-consolidated.yml and scanner regression tests; inspect results before merge.
- Browser review required: navigation paths, mobile/desktop widths, 100/125/200 percent zoom, keyboard tab/More disclosure/focus, form validation, approvals and no unintended writes.
- Railway test: consignment-beta currently remains pinned to feature/consignment-layout-foundation, latest verified deployed commit 32a0a881, SUCCESS. New integration branch has NOT been promoted.
- No production deploy, extension package, or Lightspeed writes.
- Test database remains unconfigured, so actual persistent submissions and live matching are not proven.

## Safe integration order
1. Finish CI and browser acceptance for PR #30; verify PR #24 navigation contract and shared UI assets have not changed.
2. If approved, promote *only* an isolated Railway test service to the new branch, with no Lightspeed write credentials; preserve existing beta as rollback.
3. Provision a separate nonproduction Postgres database and staff-authentication path and run migration/tests with synthetic records.
4. Wire authenticated read-only Lightspeed customer/product matching, verify duplicates and historical records.
5. Test product create previews and transaction reconciliation in an explicitly authorized sandbox, before enabling any actual POS change or delayed credit.
6. Merge the selectively reconciled work only after required approval; leave outdated PR #11/#25 unmerged and record deferral.

## Verified CI results
- Commit e179a3d5128d7ef9e27bcdffb8efa16ff54dbd65: Consignment consolidated safety SUCCESS; Scanner integration regression SUCCESS; Chromium browser acceptance SUCCESS.
- Chromium automation exercised six staff/customer viewport and zoom combinations (1440px at 100%, 900px at 125%, 390px at 200%), keyboard Enter on native More disclosure, verified navigation and original logo, selected a pending staff item, and added a second customer item. Screenshots uploaded as GitHub Actions artifact consignment-navigation-screenshots.
- This verifies automated browser interactions only; staff visual sign-off and production authentication/credit integration remain pending.

## Final predecessor and extension disposition — 2026-10-28
- Verified PR #30 is 0 commits behind consolidated baseline 24e9834a6 at this audit. PR #11 and PR #25 are historic drafts and must NOT be merged wholesale.
- Compared feature-owned files: consignment-beta HTML/JS/CSS, customer HTML/JS, the schema, consignment matching/form/product-preview/credit modules and shared adapter/branding are present in PR #30. Staff customer filtering, multi-approval, generated item preview, online-form fields, synthetic-only localStorage and local beta routes remain.
- PR #25 navigation markup for both pages was carried forward byte-for-byte; six destinations (four core operations, Consignment beta, Toolkit) and the customer form in More remain. PR #24's authoritative core-ops navigation adds the original header wordmark and a More tools disclosure; Consignment keeps its established original wordmark and a locally scoped menu. Verify future shared navigation component changes before merge.
- INTENTIONAL EXCLUSIONS: legacy consignment-layout.html static preview (replaced by functional beta), legacy special-orders.html toolbar overwrite (PR #24 owns navigation), obsolete direct extension/popup.html launcher, legacy complete server.js rewrite, standalone shared-ui/hc.css override (the consolidated blob is authoritative), old PR-specific workflows/docs/changelog (replaced by current tests and this reconciliation document).
- PR #11 and PR #25 may be closed as superseded once these dispositions and check results are recorded. Their Git branches can remain for audit history; do not delete until release coordination confirms no additional consumers.
- New sale reconciler services/consignmentSaleReconciliation.js is pure and no-write. It deduplicates repeated event IDs, refuses conflicting sales/return/void evidence, and supplies a verified sale to the existing 72-hour credit eligibility calculation. It is NOT connected to Lightspeed, scheduler, payments, or credit posting.
- Stable future launcher destination: the managed production Special Orders service's canonical /consignment route ONLY AFTER that path is deployed, employee-authenticated, functionally accepted and documented in shared navigation. Until then there is no approved production Consignment launcher URL; keep consignment-beta-test.up.railway.app strictly test-only and never hardcode it into a production extension. Shared extension popup ownership stays with integration branch / central release queue.
- Isolated test deployment preparation: existing Railway consignment-beta stays on feature/consignment-layout-foundation. For a later separate test slot, use PR #30 branch with no production DATABASE_URL, no Lightspeed write credentials, no customer synchronization, no extension package, and CONSIGNMENT_BETA_ALLOW_DB_WRITES unset or false. Test-only database must be separately provisioned and schema migrated with explicit approval, then recheck staff authorization.
