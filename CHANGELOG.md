# Hobby Corner Lightspeed — Change Log

## 2026-11-10 — Scanner UI CI efficiency (draft)

- Preserve the existing **Scanner review UI regression** workflow's name, push-only feature-branch path triggers, existing job ID and all test families.
- Run `tests/scannerDuplicateSafety.test.js` once instead of twice inside the same job. The dedicated duplicate/completeness step remains; the integrated review step retains queue, isolated creation, and employee-access tests.
- Cancel superseded Scanner UI feature-branch runs, add a 20-minute timeout and use the npm download cache keyed to `package.json`. No dependency version change, installed-module caching or security-gate removal.
- Static source-to-PR comparison verified all test commands remain except the single redundant invocation; this workflow's push-only feature-branch trigger does not run for the review PR itself. Runtime validation is pending an eligible feature-branch update or approved manual acceptance plan.
- **No merge, Chrome extension package, deployment or production change.** Reconcile with the active shared CI optimizations #46–48 before release.
