# Hobby Corner Lightspeed — Change Log

## 2026-10-27 — Shared Addon UI beta foundation (unreleased)
- Added a **scoped, opt-in** shared employee interface stylesheet in `shared-ui/hc.css` with navy navigation, shaded workspace sections, semantic controls and responsive layout.
- Added a standalone, local-only sample UI gallery: `shared-ui/showcase.html` and `showcase.mjs` (no production data or writes).
- Added source-derived Hobby Corner icon and wordmark WebP brand assets.
- Added exact-text/sanitized-rich clipboard utility and corresponding regression checks.
- Added `shared-ui/README.md` with safe rollout guidance for independent business tools and Chrome extension packaging.
- Scope: `feature/shared-addon-ui-beta-foundation-20261027` only. Not merged to consolidated, not deployed to Railway, no extension version or package change.
- Next: run Node tests and browser/keyboard/zoom acceptance, then review the PR; adoption in individual tools is separate.
