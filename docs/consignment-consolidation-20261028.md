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
