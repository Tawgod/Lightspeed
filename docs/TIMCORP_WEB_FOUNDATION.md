# Timcorp Productions Shared Web Foundation — Hobby Corner Integration

**Status:** Prepared on non-production branches; gateway/DNS and Railway production configuration unchanged.  
**Date:** 2026-11-11

## Goal

Make the existing Hobby Corner web services work behind the Timcorp Productions shared host while preserving their current Railway URLs and independent deployability.

Target host:

`https://timcorp-productions.com`

The central Timcorp gateway/path registry was not discoverable from the connected GitHub repositories or public web/DNS checks during this work. The route assignment below is therefore the **proposed Hobby Corner contract pending central gateway confirmation**.

## Proposed public routes

Use longest-prefix routing:

| Public path | Railway upstream | Purpose |
| --- | --- | --- |
| `/hobby-corner/store-map/*` | `store-map-production.up.railway.app` | Store Map |
| `/hobby-corner/labels/*` | `lightspeed-api-production-c087.up.railway.app` | Avery/label web/API surface |
| `/hobby-corner/*` | `special-orders-test-production.up.railway.app` | Employee Store Operations: Special Orders, Ordering, Preorders, GW Preorders, staff-auth and related APIs |

Expected employee landing page after approval:

`https://timcorp-productions.com/hobby-corner/special-orders`

The Timeclock Railway service is **not** a public Timcorp route in this first integration. Existing staff-auth/scanner server-to-server calls should continue to use the configured Timeclock origin. This avoids exposing Timeclock integration/admin routes and avoids colliding with the active Timeclock security-staging work.

## Gateway behavior expected

1. Forward the matching Timcorp prefix **unchanged** to the upstream service. The application strips its configured prefix internally for route matching.
2. Preserve HTTP method, query string, request body, `Authorization`, content type and normal proxy headers.
3. Preserve the original HTTPS scheme and host through standard forwarded headers.
4. Prefer longest-prefix matching so `/hobby-corner/store-map/*` and `/hobby-corner/labels/*` are selected before `/hobby-corner/*`.
5. Do not cache authenticated `/api/*` traffic.
6. Do not rewrite API response bodies.
7. Existing Railway domains remain enabled throughout migration and rollback.
8. No DNS or gateway change is part of the application branches.

## Future Railway variables after gateway approval

Do **not** set these until a staging/gateway verification window is approved.

### special-orders-test

```
HC_PUBLIC_BASE_PATH=/hobby-corner
HC_PUBLIC_LANDING_PATH=/special-orders
```

### lightspeed-api

```
HC_PUBLIC_BASE_PATH=/hobby-corner/labels
HC_PUBLIC_LANDING_PATH=/index.html
```

### store-map

```
HC_PUBLIC_BASE_PATH=/hobby-corner/store-map
```

No existing database, Lightspeed, Discord, scanner, Timeclock or security variables need to be changed for base-path support.

## Application behavior

### Dual-route support

When `HC_PUBLIC_BASE_PATH` is set, the application accepts both:

- its existing root paths, such as `/special-orders` and `/api/staff-auth/session`; and
- the prefixed Timcorp paths, such as `/hobby-corner/special-orders` and `/hobby-corner/api/staff-auth/session`.

This preserves existing Railway URLs during migration and rollback.

Invalid base paths fail at process startup rather than silently accepting ambiguous traversal/query/hash syntax.

### Browser navigation and assets

Core Operations HTML now uses relative internal navigation/assets. The server injects a validated `<base href>` for the configured public prefix, so both trailing and non-trailing page URLs resolve correctly.

The extension download page builds its own Special Orders/download URLs from the configured public base path rather than hardcoding the Railway Special Orders hostname.

The Order Split browser harness also receives a prefix-aware `<base href>`.

### API endpoints

Browser API calls for:
- Special Orders / Ordering / Preorders / GW Preorders;
- shared staff authentication;
- Avery/label UI; and
- Order Split browser harness

remain same-origin and resolve beneath the configured public base path.

Backend-to-Lightspeed, USPS, Microsoft Graph, Discord and Timeclock service-to-service calls are not rewritten.

### Sessions and cookies

Current Core Operations employee sessions are bearer tokens stored in browser `sessionStorage`; they are **not cookies**. No cookie Path/Domain/SameSite changes are required.

Because `timcorp-productions.com` is a different browser origin from the Railway domains, employees should expect to sign in once on the Timcorp origin during migration testing. Existing Railway-origin sessions remain independent and continue to work.

Do not copy browser session tokens between origins.

### WebSockets

No WebSocket/SSE path was found in the current consolidated Hobby Corner web application or Store Map service. No WebSocket gateway rule is currently required. Re-evaluate if a future feature adds one.

## Source branches

### Main Hobby Corner web/API code

`Tawgod/Lightspeed:feature/timcorp-base-path-hobby-corner-20261111`

Base:

`integration/hobby-corner-consolidation@014a7a949fe570b756b48d8f59995c1b0a434859`

### Store Map

`Tawgod/Lightspeed:feature/timcorp-base-path-store-map-20261111`

Base:

`store-map-production@c7e76b8cad6f6c740d5bc3d9c3c96a7f36ae0475`

Separate Store Map branch is required because Railway deploys that service from `store-map-production`, not from the consolidated application branch.

## Focused tests

Main branch adds:

`tests/public-base-path.test.mjs`

It covers:
- normalization/rejection of unsafe base paths;
- prefix stripping and root-route preservation;
- middleware request metadata;
- source regression checks preventing root-absolute browser navigation/API calls;
- prefix-aware Order Split harness;
- removal of the hardcoded Special Orders Railway link.

Store Map branch adds:

`store-map/publicBasePath.test.js`

It covers prefix stripping, health-path behavior, root compatibility and unsafe path rejection.

Two branch-only focused GitHub workflows were added because opening a PR would trigger several unrelated existing workflows. They perform no dependency install, browser download or database work. Exact-source runs: main web/API `43087301610` **SUCCESS** and Store Map `43087317304` **SUCCESS**. Local helper tests also passed, and source files were read back from GitHub and statically checked for remaining root-absolute internal browser URLs.

## Known integration conflicts / dependencies

1. **Timeclock staged Railway change:** production currently has an unrelated staged source change targeting `feature/owner-timeclock-scoped-credential-20261110@a595fd336c5a38dcc5ab5423a8967698777c0929`. This integration did not touch or accept it.
2. **PR #35 hierarchical navigation** changes `server.js`, Core Operations HTML and shared staff-auth/navigation files. Timcorp changes must be reconciled with #35 rather than overwriting either set.
3. **PR #59** changes `timeclock/server.js`; Timeclock was intentionally excluded from this first public-path code change.
4. **PR #61** changes Core Operations security policy/routes. Base-path support must not weaken or bypass its exact-permission work.
5. Chrome extension backend URLs are intentionally unchanged. Extension migration to the Timcorp hostname should be a later coordinated Chrome release item after the gateway is verified.
6. The central Timcorp gateway repository/configuration and final assigned path were not available through the connected sources. Confirm the proposed `/hobby-corner` assignment before gateway configuration.

## Verification still required before production

1. Confirm central Timcorp route assignment and gateway proxy semantics.
2. Create a non-production gateway route or equivalent staging proxy.
3. Configure the three `HC_PUBLIC_BASE_PATH` values in staging only.
4. Verify:
   - employee PIN sign-in and session restore;
   - Special Orders, Ordering, Preorders and GW navigation;
   - authenticated API reads/writes allowed by existing permissions;
   - label page and PDF/API flows;
   - Store Map load/save/export behavior;
   - direct Railway URLs still work;
   - forwarded HTTPS/host behavior;
   - 404s do not leak into another Timcorp project path.
5. Reconcile the base-path branch with active navigation/security branches before merge.
6. Obtain explicit approval before any production-connected merge, Railway variable change, DNS/gateway change or Chrome release.

## Production restrictions

This work does **not** authorize:
- central DNS changes;
- Timcorp gateway changes;
- Railway production variable/config changes;
- production deployment;
- merging production-connected branches;
- Lightspeed/customer/employee/database mutations;
- Chrome extension URL/package/release changes.
