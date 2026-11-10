# Hobby Corner Lightspeed — CI Changes

## 2026-11-09 — Actions usage optimization (draft)

- Foundation workflow retains the complete PostgreSQL/security/Timeclock/Scanner suite on PR and manual dispatch; removes redundant feature push. Adds superseded PR cancellation, explicit timeout and npm download cache.
- Core Operations browser and Scanner regression workflows preserve all check names and tests while adding cancellation, timeouts and download caching, including Chromium archive caching.
- Added AGENTS.md, docs/GITHUB_ACTIONS_AUDIT_20261109.md. No merge or deployment; branch-protection statuses must be verified before acceptance.
