# Scanner Railway configuration — safe preparation

Status: **Prepared, not activated** (2026-10-12). The production Railway environment was inspected before this document was written. The live `timeclock` and `special-orders-test` services currently deploy `integration/hobby-corner-consolidation` and are healthy; neither has the new `SCANNER_*` variables. No environment patch or deployment was made.

## Architecture

Chrome extension 0.3.19 (on `feature/scanner-secure-match-gateway`) → HTTPS `special-orders-test` `/api/scanner/session` and `/api/scanner/matches` → HTTPS Timeclock verify/authorize endpoints authenticated with server-only shared secret → existing Special Orders product matching endpoints on loopback.

**No Lightspeed creation/update API is mounted**. The scanner stays read-only.

## Service variables

Configure these only in a **separate Railway testing environment**, or in production only after test validation and explicit deployment approval.

| Service | Variable | Requirement |
|---|---|---|
| `timeclock` | `SCANNER_SERVICE_SECRET` | Random cryptographically secure 32+ character secret; **same value as Special Orders** |
| `timeclock` | `TIMECLOCK_PIN_PEPPER` | Reuse existing value, never rotate during scanner setup (would invalidate Timeclock PINs) |
| `special-orders-test` | `SCANNER_SERVICE_SECRET` | Same value as Timeclock, server-only |
| `special-orders-test` | `SCANNER_SESSION_SECRET` | Separate random 32+ character secret; for 15-minute signed employee sessions |
| `special-orders-test` | `SCANNER_LOGIN_LIMIT_SECRET` | Separate random 32+ character secret; hashes rate-limit keys |
| `special-orders-test` | `SCANNER_TIMECLOCK_ORIGIN` | Verified HTTPS origin `https://timeclock-production-2bfa.up.railway.app/` for current production; use test Timeclock URL in isolated testing |
| `special-orders-test` | `SCANNER_ENABLED` | `false` until tests and final activation, then `true` **only on special-orders-test** |
| `special-orders-test` | `SPECIAL_ORDERS_ADMIN_KEY`, `DATABASE_URL` | Already present; preserve existing values |

Never put PIN peppers, service secrets, session secrets, or Special Orders admin key into Chrome, GitHub, project documentation, chat, or URLs.

Generate secrets with a cryptographically secure generator, e.g. `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` on an authorized local terminal. Store only in Railway's secret variable facility.

## Controlled activation

1. Establish a separate Railway environment with independently isolated test data and verify its service URLs/branch sources. Do **not** duplicate the production PostgreSQL `DATABASE_URL` into writable test deployments.
2. Deploy both Timeclock and Special Orders services from `feature/scanner-secure-match-gateway` **to the test environment only**, preserving each service's existing root directory and start command.
3. Configure the server-side variables above; keep `SCANNER_ENABLED=false` initially.
4. Run `node scripts/scanner-config-preflight.mjs` in each service context; this checks variable presence/length without printing secrets.
5. Enable `SCANNER_ENABLED=true` on **test special-orders-test only**. Verify Timeclock internal endpoints reject requests without the service secret, PIN sign-in is rate-limited across replicas, revoked staff permissions work instantly, sessions expire, and both matching services must succeed.
6. Test the installed Chrome beta through the test endpoint. The source currently points to the production Special Orders URL and must be updated or feature-configured for isolated browser testing.
7. Obtain explicit production release approval before merging or deploying code or changing live Railway environment variables.

## Source caveats

The production download at `/extension/download` still packages the currently deployed consolidated extension, not the feature branch. Work on this branch does not automatically update the installed addon.

`scripts/scanner-config-preflight.mjs` is a **validation helper**, not a deployment or database migration. It does not modify the environment or show secrets.
