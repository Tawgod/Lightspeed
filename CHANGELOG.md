# Hobby Corner Lightspeed — Development Changelog

## 2026-11-06 — Employee Administration & Security foundation (development, unmounted)

- Created draft PR #34 on `feature/employee-admin-security-foundation-20261106`, stacked on shared services Phase 1 branch.
- Added a server-only administrator authentication gate requiring active employee session + recent passkey or TOTP + exact admin permission; privileged changes retain a separate strong step-up requirement.
- Added an extensible source-owned registry to gather all tool settings under one menu, while marking unconnected/unknown tool settings as planned or requiring audit.
- Added an inert responsive admin page with protected read-only discovery routes; no production auth bypass or write APIs.
- Added local/remote idle and absolute timeout validators, and an unapplied PostgreSQL versioned policy store with append-only audit.
- Added automated admission, HTTP/UX, registry and session-policy tests including disposable PostgreSQL.
- No production deployment, Timeclock/Lightspeed writes, extension package or active session policy changes.

## 2026-11-06 — Owner / delegated manager authorization

- Added Owner/delegated-admin permission catalog and durable PostgreSQL principals, explicit admin grants, per-tool operation scopes, per-tool settings scopes, employee tool grants and append-only authorization audit. No automatically granted Owner exists in production.
- Added administrator delegation store with strong-gated Owner-only admin grants; specific delegated manager onboarding, setting, and tool grant capabilities; active Timeclock target checks; prohibited self/Owner privilege mutations; and revocation of manager capabilities.
- Added read-only effective capabilities for server-filtered admin sections, Owner-visible role label, explicit owner permission-management forms and scoped manager tool grants.
- Added integration tests using disposable PostgreSQL and HTTP route checks for no admin access without grant, manager private-record restrictions, out-of-scope grants, unknown employee targets, and revocation.
- Changes remain on draft PR #34 only and are not mounted, deployed or authorized for live employee writes.

## 2026-11-06 — Isolated read-only administrator authentication integration

- Added synthetic isolated-staging admin browser entry using the existing signed staff PIN session followed by independently verified Google Authenticator or WebAuthn passkey. The browser holds proof in memory and discards it on page hide/sign-out.
- Added isolated test-only server-side composition with exact read-only `admin.read` / `tools.settings.read` grants for synthetic employee 901 and strong passkey/TOTP verification against the same bound session. New `HC_STAGING_ADMIN_READONLY_ENABLED` flag defaults off.
- Added read-only capability resolution to the admin metadata API, separating synthetic Owner preview from all real delegation mutation routes. No admin grant store, Timeclock employee writes or tool-setting writers are mounted in the preview.
- Added denial messages, login and factor controls, URL/Origin and forged-role rejection tests, no-write HTTP tests, and browser volatile proof tests.
- Security workflow [42293979612](https://github.com/Tawgod/Lightspeed/actions/runs/42293979612) **SUCCESS** after test-harness correction; no Railway deployment or feature flag activation.
