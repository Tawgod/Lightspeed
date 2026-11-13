# Hobby Corner — isolated employee read pilot Railway handoff

**Status:** **Deployed (isolated TEST only), Testing PASS for signed-out HTTPS/Chromium and disposable positive-access HTTP/PostgreSQL.** Not approved for live employee/Owner authentication, production, real customer data, or Timcorp gateway. Verified 2026-11-12 (America/Chicago).

## Exact deployed inventory

| Component | Verified value |
| --- | --- |
| Separate Railway project | `HC Employee Read Pilot`, `c528d08e-b835-4b72-95f2-8a05090a2195` |
| Isolated environment | `test`, `33519424-2ad3-4206-a476-253a0ae68c8d` |
| App service | `hc-employee-pilot`, `01f28a7d-b7d4-4659-ae10-4a0bca20ef6b` |
| Fresh independent PostgreSQL | `Postgres`, `a88faff0-5a0f-4e6d-a054-c947a67e2a43` and its own volume `409a0d18-0124-4172-8fbe-c14cd3f18a67` |
| GitHub source | `Tawgod/Lightspeed:feature/isolated-employee-pilot-runtime-20261112` |
| Railway source **pinned** to tested code commit | `f023bad90f269d8c40b50cb9451c881080433182` |
| Dedicated runtime deploy | `577c4250-dbe3-4746-9841-f92397f1fa39`, **SUCCESS**; Railway healthcheck `/health` PASS |
| Separate HTTPS test URL | `https://hc-employee-pilot-test.up.railway.app/HobbyCorner/` |
| Public Timcorp shared hostname | **NOT connected**. Current intended domain `timcorp-projects.com`; reserved gateway path `/HobbyCorner/` remains inactive |

**One-time database setup:** The same service initially ran `node scripts/bootstrap-isolated-employee-pilot.mjs` pinned to `f023bad`, after explicit owner approval. Deployment `81ef92ce-de58-4f44-a5c3-6f2f81ae9506` reported `Isolated employee pilot schema and restricted roles provisioned.` Then the service was switched to `node staging/employee-read-pilot-server.js` with the **administrator `DATABASE_URL` overwritten to an empty string**, bootstrap flag disabled and runtime source still pinned. The runtime startup unconditionally rejects a nonempty administrator connection and validates both reduced-privilege roles before listening. No admin database URL remains usable by the app process.

## Runtime security and scope

- **Synthetic employee only:** `staging/isolated-test-identity.js`, ID `901`, marked `synthetic_staging_only`. Four-digit disposable PIN stored as salted scrypt hash. Durable PostgreSQL account/source rate limit protects login; never use real Timeclock PINs.
- **Authenticated staff:** Existing `createStaffAuthGateway` issues 15-minute signed bound sessions with live synthetic identity re-verification. PIN alone grants **no** Core Operations read.
- **Workstation:** Browser creates a non-exportable Ed25519 private CryptoKey and stores it locally in IndexedDB; only its SPKI public key goes to the service. A **one-time** synthetic operator approval key and valid signed test session can register one workstation; registration uses a durable, atomic consume-before-insert transaction and separate login throttle. The operator key is stored only in Railway as `HC_PILOT_OPERATOR_KEY` and was **not added to source, changelog, CLI diagnostics or messages**. This is a **test-only alternative** to real independently verified Owner/manager WebAuthn commissioning; it must never be treated as a production approval mechanism.
- **Cryptographic station proof:** Existing Postgres Ed25519 workstation verifier issues a one-use 90-second challenge and an employee/session/device-bound five-minute proof. No static station role header is accepted.
- **Privilege split:** `hc_pilot_auth_runtime` can maintain only the synthetic auth throttle and workstation tables; **no access to the grant table**. Separate `hc_pilot_grants_reader` can **SELECT only** `public.hc_core_employee_pilot_grants` and cannot create schema objects or modify the grant. Startup checks reject role misuse; each grant lookup also checks actual database privileges in the same query.
- **Permission:** Only `special-orders.read` for synthetic employee `901`, inserted once by the independent bootstrap operator as a revocable grant expiring in **23 hours**. Grant does not refresh on app restart, with no public grant-management API. Revocation/expiration denies immediately.
- **Routes:** The only business endpoints admitted by the test pilot are `GET /HobbyCorner/api/special-orders/orders` and `GET /HobbyCorner/api/special-orders/stats`, returning **empty synthetic fixture data**. No real Special Orders router/customer DB, Lightspeed, Discord, Owner/admin API, vendor writes, GW automation, or Chrome extension is connected. All other business routes fail 403; unknown/Admin pages are 404.
- **Origin:** Only `https://hc-employee-pilot-test.up.railway.app` can submit one-time registration. No cross-site cookies or browser-persisted employee bearer tokens. Test session and station ticket stay in JS memory, private station key remains in local browser IndexedDB.
- **Network:** PostgreSQL is reachable through the project's private Railway host only. No external database TCP proxy/domain or Timcorp gateway route was enabled.

## Verified tests

1. **Disposable local positive authentication + SQL**: [combined GitHub run 43348234139](https://github.com/Tawgod/Lightspeed/actions/runs/43348234139), 66 existing combined foundation + 2 prior real-Ed25519/Postgres pilot tests + 2 new deployed-style restricted-role/operator HTTP tests = **70 passed, 0 failed** on exact runtime SHA `f023bad90f269d8c40b50cb9451c881080433182`.
2. **Actual deployed Railway staging**: [GitHub run 43349242115](https://github.com/Tawgod/Lightspeed/actions/runs/43349242115) **SUCCESS**. All 70 local regressions PASS, plus four live HTTPS read-only smoke groups PASS, plus real Chromium signed-out test PASS. Chromium verified the prefixed page, assets, no JS page errors, mobile layout and a non-exportable WebCrypto Ed25519 private key. This later test-only commit does not alter the pinned running app source.
3. **Railway runtime readback**: deployment `577c4250...` SUCCESS, healthcheck `/health` PASS, logs show exact 200/401/403/404 outcomes on live endpoints. Both services online, no pending changes when last verified. The existing four-service PR #63 isolated staging remains untouched at `50fda74b`; Owner locked preview and production remain untouched.

**What is NOT yet verified on deployed Railway:** A real user entering the synthetic PIN, registering their physical browser with the one-time operator key, completing signed station challenge, accessing the fixture GET and then proving real browser logout/expiry. The full positive path passed in disposable CI with the same source, but the live one-time operator key is deliberately never sent to GitHub CI or opened for testing by automation. Owner/device action remains.

## Owner's browser acceptance (test-only)

1. Open `https://hc-employee-pilot-test.up.railway.app/HobbyCorner/` in up-to-date **Chrome on the intended test workstation**; no Hobby Corner Chrome extension install or production data required.
2. Enter the **synthetic 4-digit test PIN**, delivered separately from GitHub and not a real store PIN. The login page should say synthetic employee 901; no ordinary application data becomes visible yet.
3. In your own Railway dashboard, open project **HC Employee Read Pilot** → environment **test** → service **hc-employee-pilot** → Variables. Securely reveal/copy the one-time `HC_PILOT_OPERATOR_KEY`; **do not put it in GitHub, Discord, screenshots or code**. Use it only once in the browser's "Register this test workstation" field. The private signing key stays on that browser and is not uploaded.
4. Click **Verify workstation**, which completes the independent Ed25519 signed challenge. The proof lasts five minutes. Then choose **Read fixture orders** / **Read fixture summary**. Both must show `synthetic:true`, never real customer or order details.
5. Click **Sign out**, then try to read again. It must reject access. Refreshing requires sign-in again, but the browser retains its private, nonexportable registered key in local IndexedDB.
6. Do not reuse the operator key for a second registration; this pilot intentionally permits **one** approved browser device. The initial synthetic grant expires around 23 hours after the one-time database bootstrap (approximately the evening of November 13, 2026, Chicago time); if it expires or the device registration is lost, **do not weaken the guard**. A separately reviewed operator renewal/re-enrollment is required.

## Remaining decisions before real employee rollout

- Securely commission a genuine Timeclock test identity/session authority and independently Owner/manager-approved workstation registration. The one-time synthetic operator token is not strong Owner authentication.
- Reuse the existing real origin-bound `staffPasskeysPostgres.js` implementation only after approved WebAuthn enrollment and test device ceremony. No protected write endpoints currently admit access.
- Review the full 38-scope operation and role matrix with store management; implement durable reviewed-manifest enforcement and real staff grants, backups, audit and revocation.
- Test signed-in browser session expiry and actual device replacement, actual business-handler denied paths, and proxy/cookie/origin behavior through a separately approved nonproduction Timcorp route.
- Require separate explicit approvals for real employee activation, production merges/deployments, Chrome extension packaging and DNS/gateway cutover.

**Do not claim whole-store authentication is deployed. This is a completed isolated synthetic read-only pilot setup with a manual browser acceptance step pending.**
