# Core Operations security route inventory — 2026-11-11

**Status: In Development / review-only; NOT live or mounted.** All route permission classifications remain **PENDING**, not approved access decisions. Do not install this candidate as automatic middleware or infer user permissions from client-supplied role, request body, extension Origin, username, static key, or four-digit PIN alone.

## Actual source counted

| Source | Registered endpoints | Existing mount |
| --- | ---: | --- |
| `special-orders.js` | 75 | `server.js` mounts `/api/special-orders` using `createSpecialOrdersRouter` |
| `routes/specialOrderProducts.js` | 12 | Registered as a nested router inside the same Special Orders router, after its existing auth middleware |
| **Total** | **87** | Staff and existing legacy service callers currently share the router; no new access gate is mounted |

The source-derived `services/security/coreOperationsRouteInventory.js` explicitly lists every method and route path with proposed operation, caller category and review state. `tests/core-operations-route-inventory.test.mjs` reads both source files to detect newly added/removed endpoints and missing/duplicate coverage so future integration must re-review changed API surfaces.

### Current route categories (review-only)

| Category | Routes | Proposed migration handling |
| --- | ---: | --- |
| Ordinary GET reads | 32 | Signed active Timeclock employee + independently verified station/MFA + exact `special-orders.read`, `ordering.read` or product-read grant, as appropriate; protect sensitive customer data |
| Local mutations | 30 | Require separately approved exact grants and strong step-up where financially/operationally sensitive; split oversized `*.manage` grants before enforcement |
| Service/batch or hybrid candidates | 14 | Caller identity not yet confirmed; inspect Discord, GW importer, RMS/customer metrics, notifications, reconciliation, registered background jobs; give exact dedicated service grants rather than demanding human passkey proof |
| Read-by-POST | 4 | `address/verify-usps`, `products/match-local`, `products/match-remote`, `preorders/gw/scrape-preview`; HTTP POST does not automatically mean a write, but these still need normal read admission, input bounds and audit/rate limits |
| Vendor writes | 3 | `supplier-orders/:id/push-lightspeed`, `customers/create-lightspeed`, nested `products/create-lightspeed`. Separately strong-authz, exact Lightspeed operation grant, idempotency/unknown-result reconciliation and audit. `customers/create-lightspeed` deliberately has **no** existing matching staff grant: new exact catalog operation + owner-approved policy required |
| Outbound external effects | 2 | `preorders/gw/campaigns/:id/discord-publish`, `items/:id/notifications/ready`: verify human or service caller, dedupe and audited send/notification policy |
| Public health | 1 | `GET /health` is currently before router auth middleware; least-data readiness contract. Admin-key length disclosures removed in this branch |
| Signed session check | 1 | `GET /auth-check`: currently behind legacy-key or staff session middleware; a valid session check never grants a write |

### Existing security boundary and important dependencies

- `special-orders.js` currently uses `router.use` to permit either a legacy `x-hobby-corner-key` (with no employee identity) or a signed Timeclock employee session. Authenticated route admission does **not** yet independently verify registered workstation / fresh strong factor or exact operation grants. The new shared security library is **unmounted**. Preserve existing behavior while adding tested replacement guards; no silent relaxation of protected writes.
- `shared-ui/staff-auth.js` still returns legacy key headers when it lacks a signed session. This requires synchronized website/client/backend migration; do **not** remove fallback in isolation.
- Background GW notification loop runs every 60 seconds inside the Special Orders router. Additional Discord notification endpoints and preorder automation may be externally called. **Employee inactivity does not imply these workers are inactive.** Service auth decisions need direct verified caller inventory and compatibility tests.
- The separate `server.js` also declares direct Labels, PO lookup, address verification and static UI routes. These **24 direct routes are not included** in this 87-route router inventory; they require a separate server/public/static/privileged route audit, as do the Scanner gateway, Timeclock endpoints, Admin, Discord, Rewards and Chrome extension.
- `special-orders.manage` and `ordering.manage` in the new policy candidate currently demand a recent passkey or approved IdP strong factor. That is an **unapproved broad granularity** for day-to-day staff workflows; split into normal stage/write and sensitive/high-impact operations only after owner approval and user acceptance. Existing employees' permissions remain unchanged.
- Production does not have new staff security schema/roles/crypto credential providers configured, and Owner first enrollment is still staged. Do not point staff browsers at unprovisioned passkey/worker routes.

## Browser source caller reconciliation — 2026-11-11

In the current development source, all four Core Operations browser interfaces set `const api='/api/special-orders'` and call the shared `window.HCStaffAuth` client for authenticated requests. These are **observed browser reference patterns**, not evidence that every route is exercised at runtime or that service callers are absent.

| Browser entry | Unique literal `api + '/...'` fragments in source | Examples requiring authorization design |
| --- | ---: | --- |
| `special-orders-client.js` | **37** | Create customer/product in Lightspeed, import workbook, edit Special Orders, supplier purchasing, GW sync |
| `preorders-client.js` | **6** | Preorder allocation, Discord watch review |
| `gw-preorders-client.js` | **6** | GW draft sync/review, external Discord publishing |
| `ordering-client.js` | **10** | Item routing/status, purchase-order receipt into Special Orders, notification queue review |
| **All four** | **59 per-client distinct references** | Some paths are shared across clients; this is **not** 59 unique HTTP endpoints or a complete runtime call graph |

The machine-readable `services/security/coreOperationsBrowserCallerInventory.js` captures those 59 browser-source fragments and their file ownership, all with `review:'pending'`. `tests/core-operations-browser-callers.test.mjs` compares the checked-in inventory with current source and ensures these clients continue to use `HCStaffAuth` rather than an unrelated UI sign-in. CI watches the four client source files.

**Critical limitations:** A literal fragment such as `/supplier-orders/` or `/items/` is a dynamic URL prefix, not an exact server route or permission. This source-only audit cannot determine which HTTP method, action, or employee grant applies at runtime, cannot prove what Discord workers call, and does not include API calls dynamically constructed by external services or extensions. It must not be used as access middleware, service trust or an automatic grant.

**Next review:** correlate the actual method + full URL for each browser helper with the 87 server endpoints, including write side effects. Investigate Discord bot and scheduled processors on their owning repositories/services, then introduce independently verified service-bound credentials rather than making these automated calls depend on staff TOTP/passkeys.

## Safe next implementation stages

1. Cross-reference every service/hybrid route with actual callers in `special-orders-client.js`, `preorders-client.js`, `gw-preorders-client.js`, `ordering-client.js`, Scanner/extension, Discord and scheduled jobs. Make an explicit verified caller matrix. Identify uncalled or diagnostic endpoints, but do not remove them without evidence.
2. Design **granular server-owned grants** for normal Special Order workflow changes vs privileged external vendor writes, money/credit changes and Owner management. Maintain existing authorized employee abilities and independent service credentials.
3. Add optional, **default-disabled** backend gate composition to a development-only feature router with trusted Timeclock bound-session, cryptographically verified station/passkey/TOTP and exact permissions. Unknown operations fail closed when enabled. Avoid silently using the current legacy key as MFA or generalized service grant.
4. Integrate UI login and session expiration, disabled/revoked employee behavior, off-clock use, convention mobile, and Chrome extension release queue, using disposable DB and actual store-browser acceptance.
5. Test exact operations, service callers, live vendor data protections, background jobs, migrations/rollback and physical passkey/Authenticator on isolated staging **before** an explicitly authorized production cutover.

**Program coordination:** `Tawgod/Hobby-Corner:main/SECURITY_COORDINATED_ROLLOUT.md`; development [draft PR #61](https://github.com/Tawgod/Lightspeed/pull/61). No migrations, source branch switch, credentials, employee roles, Lightspeed writes or production deployment were performed.
