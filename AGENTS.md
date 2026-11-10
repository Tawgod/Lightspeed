# Hobby Corner — AI Development and GitHub Actions Budget Rules

**Effective:** 2026-11-09. Applies to every AI assistant developing in this repository and every future feature branch or release. Follow system-specific security and release instructions in addition to these rules.

## CI budget and validation levels

**Level 1 — Routine development:** Use local syntax checks, focused unit tests and static validation for changed components. Investigate failures locally first. Batch related edits into logical commits; avoid pushes/PR edits made only to prompt a new workflow. Do not request repeated reruns of known failures. Reuse completed successful checks **only if the exact commit and test prerequisites are unchanged**. No production data or secrets in local test fixtures.

**Level 2 — PR readiness:** Run the matching PR workflow, integration tests and relevant disposable PostgreSQL or browser verification. Keep the **same required GitHub check/job names** until branch protection/rulesets are separately reviewed and changed with explicit approval. Path filters must include workflow files, affected source and tests. Do not omit security/auth, permission, payment/banking, database migration or integration validation when affected. Use the successful checks on the actual final commit; a newer commit invalidates prior approvals when affecting tested inputs.

**Level 3 — Production release:** Preserve full security, authorization/permissions, idempotency, audit/recovery, migration, deployment and rollback checks. These are mandatory even when runner minutes are scarce. Run explicit full regression and read-only deployment verification on the release candidate before any approved deployment. Never lower coverage to save minutes. Production or destructive work and Chrome extension releases require separate explicit owner authorization and extension release queue reconciliation.

## Workflow authoring rules
- Prefer PR-only triggers for feature branches already covered by PR validation; retain push validation on protected integration/production branches where needed.
- Use `concurrency.group` scoped to workflow and PR number or ref, and `cancel-in-progress` for superseded **PR development** runs. Do not cancel production deployments or independently authorized release jobs.
- Add realistic `timeout-minutes` for each job. Preserve security tests and all branch-protection check names. Avoid adding schedules; justify any scheduled monitoring in a review and document owner, frequency and cost.
- Use paths only when coverage is demonstrably specific. Every workflow's own YAML must be included in its path filter. Never silently convert a required check into permanently pending.
- Cache downloads, not mutable installed modules. This repository has no lockfile on the audited branches; do not enable `setup-node` npm caching that requires one, or replace `npm install` with `npm ci` until a reviewed lockfile exists. Do not cache credentials.
- If using `workflow_dispatch` for PR readiness or release checks, record exact commit and run URL. Do not introduce an unsafe broad `workflow_run` privilege escalation.
- Avoid equivalent full test suites on both push and PR of the same commit. Do not remove tests from one workflow before verifying another mandatory workflow reliably owns them.
- Read recent workflow run conclusions and logs **before** rerunning CI. Fix or explain failures; prefer local tests. For rapidly updated PRs, allow superseded jobs to cancel.
- Review actual billed runner minutes, not workflow run counts, in GitHub billing/usage data. Wall-clock run durations are only an estimate; self-hosted, multi-job and runner overhead alter billing.

## Repository-specific coordination
- `Tawgod/Lightspeed` has multiple active source/feature branches. An optimized workflow merged into one branch does not automatically update another; reconcile at integration time.
- Preserve Timeclock employee authentication, shared security, Admin grants, scanner and Core Operations acceptance. Changing test selection, branch protection, or release requirements needs explicit review.
- For Chrome extension packaging, versions or publication: first inspect `Tawgod/Hobby-Corner:main/CHROME_EXTENSION_RELEASE_QUEUE.md`, active extension PRs and `Tawgod/Lightspeed:integration/hobby-corner-consolidation`; update the release queue after an approved release.
- Record meaningful workflow and CI behavior changes in `CHANGELOG.md` and the project's central handoff. Do not merge/deploy as a side-effect of CI optimization.

## Current PR contract
The 2026-11-09 optimization introduces superseded PR cancellation, conservative job timeouts and npm/Playwright **download** caches while preserving the existing test commands and check/job names. Foundation validation remains PR-triggered; redundant feature-branch push duplicates are removed only where PR coverage exists. Review actual required checks before accepting any trigger changes—GitHub App access may not expose branch protection settings.
