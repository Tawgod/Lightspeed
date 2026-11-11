# Hobby Corner — all-tool shared authorization candidate (2026-11-11)

**Status: In Development; not mounted, not deployed, not an owner-activation release.**  
**Branch:** `integration/security-all-tools-20261111`, derived from Owner staging PR #60's tested head `6b6498a01d0cfca42db273f00e97680d140a6ccb`. This branch intentionally leaves the existing production `server.js` and Timeclock routes unchanged; deploying this branch now would not provide cross-tool enforcement.

## Why this change exists

The verified Admin catalog `services/security/adminPermissionCatalog.js` already defines exact `TOOL_OPERATIONS`, but the existing staff assurance policy only covered generic `tools.read`/`tools.stage` and a few write operations. This discrepancy prevented feature owners from requesting an explicit shared policy result for their own action without making up a parallel authorization convention.

`services/security/staffAccessBaseline.js` now derives an exact operation policy for **every cataloged tool operation**, requiring a server-verified active signed Timeclock session, independent staff-device or strong-factor assurance, and an exact backend permission grant. Unknown actions remain denied. The current legacy generic action strings are kept temporarily for compatibility; they do not bypass the same checks.

## Proposed assurance classification (requires store-owner policy acceptance before mounting)

| Class | Operations | Required independent assurance |
| --- | --- | --- |
| Routine read, draft, Scanner review | `products.read/draft`, `scanner.lookup/stage/approve`, `purchase-orders.read/draft`, `inventory.read`, `sales.read`, `store-credit.read`, `special-orders.read`, `ordering.read`, `consignment.read`, `timeclock.self.read/clock` | Registered cryptographic workstation or fresh server-validated employee-bound MFA, **plus** exact server grant |
| High-impact modification | `products.create/edit/archive`, `purchase-orders.write`, `inventory.adjust`, `sales.write`, `store-credit.write`, `special-orders.manage`, `ordering.manage`, `consignment.manage` | Fresh employee-bound passkey, security key or approved IdP MFA, **plus** exact server grant; station alone or TOTP alone is insufficient |

A Scanner `approve` action remains a *review/staging* permission only. It is not permission to alter a live Lightspeed product or inventory. `special-orders.manage` and `ordering.manage` are conservatively classified high impact as an **unmounted candidate**; the owner must accept or refine scope/suboperations to avoid unexpectedly denying ordinary employees' existing order-workflow abilities. We must not unilaterally change current store permissions.

**No clocked-in requirement:** The policy only checks active employee identity, assurance and exact permission; time entries and shift schedules are separate from tool access.

## Tests in this branch

- `tests/security-all-tools-operations.test.mjs`: every declared tool operation mapped exactly once to frozen action policy; routine access works with registered workstation/TOTP and exact grant; privileged writes deny with station/TOTP even if the grant is present; passkey+grant works only for selected operation; forged owner/browser headers, unknown actions, disabled employees and permission-service failures deny.
- Reuse existing `tests/shared-staff-security.test.mjs` and `tests/shared-staff-bridge.test.mjs` regressions.
- `.github/workflows/security-all-tools-policy.yml`: bounded Node 22-only CI; no Railway deploy, database, secret access, external Lightspeed writes, or Chrome packaging.

## Reviewed Phase 2 read components selectively reconciled

Rather than blindly merging the diverged Phase 2 PR #33 branch, the candidate now ports **unchanged** source blobs from #33 and #38 after verifying that the existing Phase 1 `services/lightspeed/staffAdapter.js` and `policy.js` dependencies are **byte-identical** to those in the Owner candidate:

- `services/lightspeed/permissions.js` + `tests/shared-lightspeed-permissions.test.mjs` from PR #33. Exact backend Lightspeed operation grants. Existing Scanner `canLookup` supports verified reads; `canApprove` does not imply a live write. All new writes remain off by default and require an independent grant.
- `services/lightspeed/secureReadPolicy.js` + `tests/shared-lightspeed-secure-read.test.mjs` from PR #38. Requires signed Timeclock session, backend workstation or independent factor, general tools read admission **and** per-operation read grant.
- `routes/sharedLightspeedRead.js` from PR #33. Read-only HTTP router that checks authorization before invoking vendor read adapters. Still deliberately **not mounted** on `server.js`.

Existing `services/lightspeed/staffAdapter.js` and `policy.js` were compared by GitHub blob SHA across branches and matched exactly, so no base behavior was replaced.

The expanded `security-all-tools-policy.yml` CI now checks read-policy syntax and uses the original PR #33/#38 regression suites, including denied HTTP calls making zero data-service calls. **Results of the expanded workflow must be verified at the new PR head before claiming tested.** No production service, vendor API, database or extension changed.

## Required subsequent integration

1. Reconcile PR #32 Phase 1 and diverged PR #33 Phase 2, PR #38 secure-read admission, PR #34 Admin, PR #35 navigation, PR #51 transport safety, PR #59 Timeclock scoped Owner, and Owner setup PR #60. Preserve existing Core Operations and Timeclock behavior.
2. Connect the actual `staffSecurityAccessGate.authorize({request,action})` to each feature backend with independently verified session, workstation/MFA and exact backend operation grant adapters. No client-supplied role or headers are trusted.
3. Update common web client login/session and expiration UI, keeping supported store and convention mobile workflows. Remove legacy-key fallback only with tested server migration.
4. Coordinate Chrome extension Timeclock/Scanner changes through `Tawgod/Hobby-Corner:main/CHROME_EXTENSION_RELEASE_QUEUE.md`, and test registered station hardware challenge-response in loaded Chrome.
5. Stage isolated Owner app/PG role/schema and real-device verification. New admin identity and real Owner activation remain separately approved.
6. Run Core Ops, Scanner, Timeclock, Order/Preorder, Product Manager, Consignment, PO/Labels, Admin and background-service test suites together. Scope production deployment carefully; the three core Railway services share integration branch by default.

**Project-wide roadmap:** https://github.com/Tawgod/Hobby-Corner/blob/main/SECURITY_COORDINATED_ROLLOUT.md
