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

## Combined-source disposable PostgreSQL acceptance — PASS (2026-11-12)

**Verified target:** `Tawgod/Lightspeed:feature/shared-foundation-security-web-20261112@90e91c9b4d6cd07df1dff3de79100073bb819a72`, owner-run isolated Codespace `/workspaces/Lightspeed-security`, PostgreSQL 18 localhost-only Docker harness `bash scripts/run-isolated-security-status-postgres.sh`.

**Exact observed output:** `tests 13`, `pass 13`, `fail 0`, `cancelled 0`, `skipped 0`; `Disposable database verification completed. Temporary container will be removed.` and `Verified disposable PostgreSQL container removal.` The repository restored `integration/security-all-tools-20261111` after the detached-HEAD test; Git's warning about eleven commits being left behind refers only to commits without a **local** branch. The authoritative GitHub feature branch still contains them.

**Coverage verified against real disposable SQL:** routine progress and audit, prohibited downgrades, strong-proof completion/cancellation and notification suppression, forced-DB-error atomic rollback, concurrent row locks, Discord claim lease and expiry/reclaim, scoped service completion and rollback, GW reaction rollback, GW mark-submitted rollback, old-key/unrecognized-target denial. Fixture-triggered Discord and GW error logs are intentional negative tests.

**Automated checks:** GitHub Actions on this exact commit: scanner `43275029874` SUCCESS, combined foundation `43275029848` SUCCESS, shared UI `43275029856` SUCCESS, shared security policy `43275029878` SUCCESS, Core Operations UI/Chromium `43275029869` SUCCESS. All **five passed**.

**Meaning:** Combined-source code and disposable-database regression gates are passed. This does **not** establish deployed, signed-in, gateway-routed, or real-worker compatibility. No staging or production service was deployed as part of this verification.

## Isolated staging acceptance runbook — not yet authorized

1. **Isolation preflight:** Confirm an independent test deployment target/source commit, isolated PostgreSQL database (fresh/nonproduction with no customer data), test-only Timeclock/staff identities and fake/disconnected Discord/Lightspeed credentials. Inspect Railway staged-change diffs first; do **not** apply the unrelated staged updates already present in the test and production projects, and do not point a staging branch at a live production database.
2. **Routing:** Validate both direct root paths and a staging proxy that forwards exact `/HobbyCorner/` prefixes (longest prefix for Store Map and Labels). Confirm `/HobbyCorner/store-operations`, `/special-orders`, CSS/JS/logo assets, deep links, API route method/query/body/Authorization, and safe 404/503 on unmatched/offline routes.
3. **Employee authentication:** Use separate test PIN sessions; confirm sign-in, sign-out, timeout and revocation, no session sharing between origins, no forged headers or browser role claims. Exercise disabled/denied Admin link and a known authorized `admin.read` session; no real Owner onboarding or production grants in this test.
4. **Security staging activation (separate explicit approval):** Only after independent actor and factor commissioning, mount the candidate default-deny Core Operations route admission in *staging only*, with exact test route grant manifest and no wildcard fallback. Verify the side-effecting allocation refresh requires `special-orders.purchase-metrics.refresh` and recent strong proof, while basic allocation read does not.
5. **Workers:** Verify actual deployed machine caller source before issuing a credential. The current Discord bot `main` lacks the historical Special Orders worker calls; GW submit callbacks have no observed deployed executor. Do not commission unused service identities or run a real Discord/Lightspeed side effect in this acceptance.
6. **Gateway cutover boundary:** Do not activate the central Hobby Corner route until staging's positive and negative authentication, session, redirects, assets, Staff Admin and independent upstream smoke tests have signed-off results. Retain existing Railway domains. Any central public route/DNS/production deployment needs a *separate explicit authorization and rollback plan*.

**Proposed staged environment variables (only after approval):** `HC_PUBLIC_BASE_PATH=/HobbyCorner`, `HC_PUBLIC_LANDING_PATH=/store-operations`. Keep the central `timcorp-projects.com/HobbyCorner/` route inactive during isolated testing. Logs must redact bearer tokens, employee data, keys and raw supplier payloads.

**Readiness decision:** `Testing` — combined source + disposable SQL PASS; **Blocked for staging activation** until a safe isolated environment and test-only identities are explicitly approved.

## Acceptance before staging approval
- Run focused combined policy, Timcorp/basepath and navigation/dashboard/Admin contract tests in CI/isolated local test. No production dependencies.
- Verify Store Operations root and prefixed pages, assets, deep links, staff PIN/sign-out and denied/Admin link on a non-production browser/proxy environment, then real staging Timeclock session and revocation.
- Commission independent machine identities only for currently verified workers, not dormant legacy Discord or unobserved GW submission callbacks.
- Deploying even to staging requires an explicitly approved isolated environment/configuration. No unreviewed source merge or gateway cutover.

## Merge order
Retain this branch as draft until both PR #61 security and PR #35 navigation are reconciled with their own review owners and PR #62 integrated changes. Avoid silent one-sided replacement of `special-orders.js` or `server.js`. Production remains on its existing Railway source until separately authorized.
