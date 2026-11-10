# Hobby Corner GitHub Actions budget and CI optimization audit

**Date:** 2026-11-09
**Scope:** `Tawgod/Lightspeed` active shared-services, Admin, unified-navigation and first-Owner feature branches; `Tawgod/Hobby-Corner:main` project coordination repository.
**Status:** Read-only history inspection completed; optimization changes proposed in draft PRs. No required check removed, no merge/deployment.

## Data provenance and limits

- GitHub REST Actions run history reported **1,460 Lightspeed workflow runs dated November 1–9, 2026**. Because the GitHub listing is capped at 1,000 results over broad windows, we queried each day separately and collected all 1,460 using paginated daily results.
- We computed workflow counts and approximate wall-clock duration using `run_started_at` and `updated_at`. These timestamps are **NOT billed runner minutes**: queued/waiting time, job parallelism, OS billing multipliers, cancellation and runner startup may differ. GitHub billing allocation and branch-protection details were not accessible to the connected GitHub App. The account-wide **1,800/2,000 included monthly minutes** is supplied by the project owner, NOT independently verified billing.
- The 1,460 runs total approximately **1,920 elapsed run-minutes** across workflow records, not an accurate invoice. This is unusually intense development activity and not a stable monthly forecast.
- `Tawgod/Hobby-Corner:main` has **no tracked workflow files** and the inspected Actions history returned no runs in the requested period.
- The Lightspeed repository default `LivBranch` has no workflow files; active feature and integration branches contain different CI definitions. Branch-specific changes must be reconciled as the release/integration branches advance.
- GitHub rulesets list was empty; branch-protection API was inaccessible to the App. Required status/check context settings therefore require a human administrator to verify before merges.

## Highest consumers (observed Nov 1–9)

| Workflow | Runs | Estimated mean elapsed run | Approx. total run-wall minutes | Drivers |
| --- | ---: | ---: | ---: | --- |
| Shared Lightspeed foundation | 543 | ~97 seconds | ~878 | Massive full security/PostgreSQL/Timeclock/Admin/Scanner suite, 238 push + 305 PR events, many development commits, ~100 failed runs |
| Core Operations UI navigation | 255 | ~133 seconds | ~566 | Playwright package and Chromium downloads, browser smoke tests on broad HTML/shared UI/server paths |
| Scanner integration regression tests | 313 | ~66 seconds | ~342 | Broad scanner/server paths and multiple active PR updates, overlaps scanner tests inside foundation |
| Unified hierarchical navigation | 133 | ~21 seconds | ~46 | 67 push + 66 PR runs, almost every commit repeated |
| Navigation admin permission contract | 100 | ~26 seconds | ~44 | 50 push + 50 PR runs, Docker/Postgres integration and redundant unit tests with navigation |
| Shared UI reconciliation | 66 | ~19 seconds | ~21 | Repeated PR updates |
| Employee Admin integration contract | 18 | ~15 seconds | ~5 | Nine push/PR duplicates |
| Others (including first Owner/security focused PR workflows) | 32 | ~8–20 seconds each | ~18 | Source-focused tests, mostly PR-only |

*Approximate wall minutes are rounded. There were 1,460 total runs, many with same-commit duplication and failed development attempts. No workflow with a `schedule:` trigger was found among the inspected active workflow files.*

## Trigger and check inventory

Inspected workflows across active branch trees (some exist only in feature branches):

| Workflow | Trigger summary | Coverage / level |
| --- | --- | --- |
| `shared-lightspeed-foundation.yml` | Broad service/security PR paths; previously feature push + PR; manual dispatch | Level 2/3 full security/Postgres integration |
| `core-ops-navigation.yml` | Core UI PR paths; legacy feature push | Level 2 browser/Playwright acceptance |
| `scanner-tests.yml` | Scanner PR paths; legacy feature push | Level 2 scanner integration |
| `shared-ui-reconciliation.yml` | Shared UI PR paths; legacy feature push | Level 1 focused UI tests |
| `hierarchical-navigation.yml` | Navigation PR paths plus redundant feature push | Level 1/2 focused navigation |
| `navigation-admin-contract.yml` | Admin nav PR paths plus redundant feature push; manual dispatch | Level 2 authorization/PostgreSQL |
| `employee-admin-integration.yml` | Admin integration PR paths plus redundant feature push; manual dispatch | Level 2 admin permissions |
| `scanner-ui-check.yml` | Scanner preview/creation feature push paths | Level 2 scanner/product review |
| `scanner-preview-package.yml` | Manual dispatch and narrow scanner extension push | Manual packaging preview |
| `gw-parser-startup-check.yml` | Narrow GW parser push path | Level 1 syntax/fixtures |
| `staging-security-audit.yml` | Dependency-related feature push; manual dispatch | Level 2 security advisory inventory |
| `primary-employee-security-readiness.yml` | Read-only primary identity PR paths | Level 1 signed identity contract |
| `primary-employee-identity-discovery.yml` | Focused primary identity PR paths; manual dispatch | Level 1/2 identity and HTTP |
| `primary-timeclock-verification-wiring.yml` | Focused Timeclock integration PR paths; manual dispatch | Level 2 identity composition |
| `primary-live-totp-enrollment-gate.yml` | Focused factor-enrollment PR paths; manual dispatch | Level 2 TOTP/security |
| `independent-primary-enrollment-approval.yml` | Focused independent approver PR paths; manual dispatch | Level 2 permission/security |
| `first-owner-commissioning.yml` | Focused first Owner PR paths; manual dispatch | Level 2 commissioning |
| `first-owner-signed-attestation.yml` | Focused signed identity PR paths; manual dispatch | Level 2 digital authorization |

No schedule or unattended polling job was identified in these workflow definitions. No automatic security, payment or deployment tests were intentionally disabled.

## Changes proposed (separate review branches)
1. **Phase 1 shared services:** Remove redundant feature push of foundation when its PR already runs to an allowed base; keep PR and dispatch. Add per-PR concurrency cancellation, 30-minute timeout and npm-download cache keyed to `package.json`. Preserve all existing test steps, PostgreSQL and check names. Add concurrency, timeouts and caches to Scanner and Core Operations; cache Playwright browser download for unchanged fixed version.
2. **Unified navigation:** Remove redundant push events from navigation and Admin navigation workflows, retaining PR coverage; add cancellation/timeouts/npm-download cache and Playwright browser cache for Core Operations. Keep existing Postgres and permission integration tests.
3. **Admin security foundation:** Remove redundant feature push for Admin integration/foundation where PR coverage exists, keep Level 2 validation; add cancellation/timeouts/cache and retain existing security tests and check names. Add PR-base path for the Admin review branch in this dedicated Admin change proposal.
4. **AI contribution policy:** `AGENTS.md` on the relevant development branches defines 3 levels, no gratuitous pushes/retries, cache and concurrency rules, production safety and exact-commit verification.

## Expected savings (NOT billing observations)
- Eliminating feature push/PR duplication removes one workflow run per duplicate eligible commit. In the audit, foundation had 238 push executions and navigation/Admin added 126 duplicate push executions; many were co-triggered with PR checks. Actual avoided runs depend on **which optimized branch is merged, existing open PR coverage and future change rates**.
- At similar high commit activity, avoiding eligible duplicate pushes alone plausibly saves **~200–400 run-wall minutes per 9-day interval**, or roughly **~650–1,300 elapsed run-minutes per 30 days**. This is not billable minutes and must not be presented as account savings; it is an indicative extrapolation.
- Cache benefits are unmeasured until a comparable production run sample exists. Playwright browser caching should reduce repeated network/download overhead but may not reduce OS dependency installation; no cache hit-rate is claimed.
- **Conservative planning range:** expect **15–35% fewer avoidable Actions executions** on the modified PR-development branches at a similar activity level; the corresponding account billing-minute reduction is unknown until verified against the GitHub usage dashboard. Avoid treating this percentage as a guarantee or a reduction in mandatory test coverage.

## Risk controls and review requirements
- Source branches have different YAML; inspect all active branches before backporting optimizations. A change in Phase 1 does not reach Admin or Navigation automatically.
- **Required-check risk:** Branch-protection status contexts could not be read using the GitHub App. Before merge, a repository administrator must verify mandatory check names and that PR path conditions produce required checks. This work keeps existing workflow names and job IDs unchanged. Do not merge any trigger/path changes that leave protection checks waiting.
- Preserve full shared foundation security/postgres and Core Operations browser acceptance on code changes. Do not remove duplicated scanner tests or repeated navigation assertions before another trusted owner/check ensures equivalent coverage.
- The branch lacks `package-lock.json`. `setup-node cache: npm` and `npm ci` are intentionally NOT used; only `~/.npm` download cache is introduced.
- `actions/cache` and Playwright downloads require cache capacity and safe restore behavior; monitor cache hit rate and invalidation. Do not cache `node_modules` or credentials.
- No YAML merges, CI requirements, deployment settings, production data, authentication permission policies or security validators are changed directly in production.

## Recommended next actions
1. Review draft optimization PRs and required-check contexts. Accept into the proper development bases and reconcile backports, without automatic release.
2. Compare **billed minutes** and run counts for the next week in GitHub Settings > Billing against this baseline. Record per-workflow `job.started_at`/`job.completed_at` and OS/runner multipliers for better estimates.
3. Add and review a dependency lockfile; only then consider `npm ci` and native `setup-node` cache.
4. Review consolidating identical scanner/navigation test lists and moving the full foundation to a deliberate PR-readiness/release gate, but only after branch protection and production safety reviewers approve equivalent check coverage.
5. Do not start new scheduled workflows or bypass strong security/deployment gates to save runner minutes.
