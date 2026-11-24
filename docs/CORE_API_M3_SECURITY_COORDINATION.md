# Core API M3 — offline integration and Security coordination

Source: approved V2 2365de8af4e8d69b162f6909d1f78be246e74fdf. No production integration.

## Security review request
Security owns verification of active identity, operation grants, revocation, environment and resource/field scope. Core currently consumes authorizeRead({operation,context,mode:'read',environment,correlationId}) => literal true; all other outcomes deny. Context is server-owned, not a client assertion. Before admission acceptance, Security must specify how verified actor, expiry/revocation, exact operation, target/resource and field constraints are represented and bound to the request. A boolean grant alone does not communicate field/resource restrictions; do not mount a gateway using this seam until resolved. Never adapt legacy active omission to active=true. Synthetic fixture doubles are not authentication implementations. No grants issued.

## Cross-domain fixtures
tests/core-api-m3-integration.test.mjs composes existing readers with the core.v1 envelope, request-scoped trace closure and existing domain projections. Customer contact search and sale coverage, catalog exact lookup, inventory observation and PO detail are synthetic only. Catalog display projection is a test-only explicit allowlist, not a new domain policy. The test closure demonstrates correlation without editing domain exports; manager/domain owners must agree production adapter ownership. No raw data, costs or contact strings should be returned by these fixture operations. Real field-level policies remain Security/domain decisions. No stock or receipt inference. Malformed customer responses map to incomplete read; some legacy readers throw plain errors with code rather than typed errors (inventory), so taxonomy alignment requires coordinated review rather than silent change.

## POST-for-read proposal
Potential X-Series inventory bulk read: candidate POST /api/2026-04/inventory (exact method/path/schema NOT verified; do not implement against this guess). Existing verified source uses GET /api/2026-04/inventory/:productId. Inventory owner must supply official API reference and exact version, path, body keys/types/limits, non-mutating semantics and response/pagination evidence; manager approves narrow operation and Security grant. Then consider a dedicated read-only transport method pinned to that exact path, no arbitrary method/URL, bounded validated body/response, no write opt-in, no retry without documented safety. No POST executed or enabled.

## Dependency reproducibility
V2 package.json uses semver ranges and no lockfile; npm install --package-lock=false is not deterministic. Recommend manager-owned lockfile generated with pinned Node/npm and approved registry, review resolved dependencies/integrities and vulnerabilities, then npm ci --ignore-scripts --no-audit --no-fund in isolated CI. Verify existing Railway build/install behavior and lockfile compatibility before any production change. Do not fabricate a lockfile or change manifest independently. Dependency-free M3 suite needs only Node 22; combined baseline still requires full regression before release.

## Stop gate
Security exact grant/resource/field acceptance, manager integration approval and domain owner projection agreement. No live route, vendor traffic, database change, feature switch, merge or deployment.
