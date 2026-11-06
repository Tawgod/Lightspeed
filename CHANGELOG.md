# Hobby Corner Lightspeed — Development Changelog

## 2026-11-06 — Employee Administration & Security foundation (development, unmounted)

- Created draft PR #34 on `feature/employee-admin-security-foundation-20261106`, stacked on shared services Phase 1 branch.
- Added a server-only administrator authentication gate requiring active employee session + recent passkey or TOTP + exact admin permission; privileged changes retain a separate strong step-up requirement.
- Added an extensible source-owned registry to gather all tool settings under one menu, while marking unconnected/unknown tool settings as planned or requiring audit.
- Added an inert responsive admin page with protected read-only discovery routes; no production auth bypass or write APIs.
- Added local/remote idle and absolute timeout validators, and an unapplied PostgreSQL versioned policy store with append-only audit.
- Added automated admission, HTTP/UX, registry and session-policy tests including disposable PostgreSQL.
- No production deployment, Timeclock/Lightspeed writes, extension package or active session policy changes.
