# Shared Timcorp path + Unified Navigation composition — 2026-11-12

**Status:** In Development, isolated branch only; no deployment, route activation or live grant.

This branch is based on `feature/unified-hierarchical-navigation-20261109` at `7b98767dabdfce9579b5d2ed304632a0f704e167` and ports compatible Timcorp public-base-path behavior from `feature/timcorp-base-path-hobby-corner-20261111`.

## Included
- Preserve the Store Operations dashboard, Priority Review, nested Special Orders > Preorders > GW and Purchasing / Ordering navigation, plus the backend-verified Admin link.
- Reuse the tested `services/publicBasePath.js` for strict `HC_PUBLIC_BASE_PATH` validation and prefix stripping while retaining Railway root paths.
- Inject a validated HTML `<base href>` for the six web entrypoints, including Store Operations and the label interface.
- Make the four Core Operations browser clients, the Timeclock session helper, admin.read visibility check, dashboard/priority review fetches, and Order Split harness resolve same-origin URLs within the base path.
- Preserve external Consignment and Toolkit links until their own approved gateway routes are verified. No untrusted proxy prefix header is used for routing.
- Keep all existing production access behavior when `HC_PUBLIC_BASE_PATH` is unset.

## Timcorp gateway contract — hostname confirmed, route not activated (2026-11-12)
- **Confirmed shared hostname:** `https://timcorp-projects.com` (owner clarification supersedes prior `timcorp-productions.com` proposal).
- **Working gateway prefix:** `/HobbyCorner/`, consistent with `Tawgod/timcorp-projects-foundation:main`. This remains **planned/503** until central owner approval and acceptance.
- **Proposed employee landing:** `https://timcorp-projects.com/HobbyCorner/store-operations` only after activation.
- **Proposed upstream:** `special-orders-test-production.up.railway.app`, to be tested under an isolated proxy before activation.
- Forward the matched path prefix unchanged, with original method/query/Authorization and HTTPS forwarded headers.
- **Proposed application variables, not set:** `HC_PUBLIC_BASE_PATH=/HobbyCorner`, `HC_PUBLIC_LANDING_PATH=/store-operations`.
- Keep existing Railway service domains active for independent deployment and rollback.
- Store Map and Lightspeed Toolkit/labels remain separately deployed and require their own longest-prefix gateway routing/variable approval. No lowercase path alias or central DNS/gateway change is assumed.

## Security and verification
This composition includes **only** the UI branch's existing Admin navigation visibility checks. It does not mount or grant the pending Core Operations admission policy from security PR #61. A visible Admin link remains a read-only hint, not authorization to change employees.

Before merging/deploying: run `node --test tests/public-base-path.test.mjs`, nav/dashboard/admin test suites in Codespaces, and test prefixed and unprefixed paths via isolated loopback browser/API requests. Verify expired staff login, admin link denial, dashboard failure display, nested navigation, redirects and assets. Exact route/auth grants and real Timeclock/Owner commissioning are independent gates.

Branch composition is deliberately distinct from navigation PR #35 and security PR #61. Reconcile both before merging or production activation.
