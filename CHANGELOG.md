# Hobby Corner Lightspeed — CI Changes

## 2026-11-09 — Navigation Actions optimization (draft)

- Unified navigation and navigation Admin checks stop double-running on feature push/PR while preserving PR test and PostgreSQL permission coverage.
- Core Operations and Shared UI checks add obsolete PR cancellation and timeouts; Chromium/npm downloads are cached without changing existing tests.
- AGENTS.md added. No production changes; required status names retained and pre-merge check protection review pending.
