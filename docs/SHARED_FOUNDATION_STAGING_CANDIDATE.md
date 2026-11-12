# Hobby Corner shared foundation — combined staging candidate

**Status:** In Development; candidate only. Last verified 2026-11-12.

## Source integration
- Base: `Tawgod/Lightspeed:integration/security-all-tools-20261111` at `9ee0e4cfc03852e0986a1e38a82bb7973f95f5d6`.
- Compose `feature/timcorp-unified-nav-integration-20261112` PR #62 (itself stacked on the existing Navigation PR #35).
- This combined candidate ports the shared dashboard/navigation/basepath/server auth visibility and tests **without replacing** security changes to Special Orders transactions, verified audit actor, Discord claim leases, GW reaction and submission.
- Adds the UI branch's `GET /priority-review` count-only endpoint and records it in the existing review-only source route inventory, increasing the exact count from 87 to 88. Also tracks the new browser-side request fragment.
- Security admission stays **unmounted** and zero-grant by default. The separate query-sensitive `allocation-refresh-v1` operation remains review-only.
- No direct Lightspeed write, live message, role grant, scanner/Chrome release or Railway deployment.

## Confirmed shared hostname and pending gateway activation — 2026-11-12
The owner confirmed **`https://timcorp-projects.com`** as the intended shared hostname. The earlier `timcorp-productions.com` destination is superseded; do not configure a new domain or treat it as an alias.

The connected central gateway `Tawgod/timcorp-projects-foundation:main` documents **`/HobbyCorner/`** as its currently reserved path, but it is **not connected (HTTP 503)**. Use `/HobbyCorner/` as the *working integration convention*, pending central gateway-owner confirmation and nonproduction proxy/browser verification. Do not infer that the old lowercase `/hobby-corner` path is an active alias. No route registry, DNS, Railway variables, or central gateway was changed.

**Proposed staging-only application configuration after approval:** `HC_PUBLIC_BASE_PATH=/HobbyCorner` and `HC_PUBLIC_LANDING_PATH=/store-operations`. The employee landing would be `https://timcorp-projects.com/HobbyCorner/store-operations` **only after** the gateway route is activated and verified. Existing Railway URLs must remain operational.

## Acceptance before staging approval
- Run focused combined policy, Timcorp/basepath and navigation/dashboard/Admin contract tests in CI/isolated local test. No production dependencies.
- Verify Store Operations root and prefixed pages, assets, deep links, staff PIN/sign-out and denied/Admin link on a non-production browser/proxy environment, then real staging Timeclock session and revocation.
- Commission independent machine identities only for currently verified workers, not dormant legacy Discord or unobserved GW submission callbacks.
- Deploying even to staging requires an explicitly approved isolated environment/configuration. No unreviewed source merge or gateway cutover.

## Merge order
Retain this branch as draft until both PR #61 security and PR #35 navigation are reconciled with their own review owners and PR #62 integrated changes. Avoid silent one-sided replacement of `special-orders.js` or `server.js`. Production remains on its existing Railway source until separately authorized.
