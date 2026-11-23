# Core Shared API Contract Baseline — Milestone 1 Candidate

**Date:** 2026-11-23
**Ownership:** Hobby Corner Core Shared API Foundation, coordinating with Foundation Manager
**State:** documentation-only candidate; no application routing, feature behavior, migrations or deployment changed.
**Base dependency:** PR #51 on Phase 1 PR #32; Phase 2 PR #33 is stacked separately and must be reconciled.

## Existing source to reuse

- `services/lightspeed/client.js` — server-side transport, local path and origin checks, GET/HEAD retry, 10-second default timeout, 2 MiB default response limit, JSON decoding, correlation ID, non-read denial unless expressly enabled.
- `services/lightspeed/idempotency.js`, PostgreSQL adapters, audit and mutation orchestration in PR #32 — durable scoped claims, immutable audit and verified readback. Not deployed.
- `services/lightspeed/readCollection.js` in PR #33 — X-Series version cursor versus /search offset pagination, strict page/row and completion checks. Not deployed.
- `services/lightspeed/permissions.js` and unmounted read gateway in PR #33 — candidate only; consume independently approved Foundational Security identity and grants, never duplicate them.
- `services/lightspeedApi.js` on integration baseline — existing operational legacy adapter, keep behavior unchanged until consumer parity acceptance.

## Interface ownership and version boundaries

| Interface | Core responsibility | Consumer/domain owner |
| --- | --- | --- |
| `transport.request(path,{method,body,correlationId})` | Server-only vendor call, safe timeout/retry/errors | All domains |
| `readCollection` version cursor / offset | Proven completeness, no partial-success on cap/cycle | Product, Inventory, Customer/Sales, Purchasing |
| `LightspeedTransportError` | `status`, `code`, `retryable`, `mayHaveWritten` | Each gateway route maps to safe HTTP envelope |
| Idempotency + audit + readback | Durable scoped fingerprint and unknown state; never blind write retry | Every approved mutation owner |
| Security admission | Consume verified principal and exact operation grant from Foundational Security | Security owns identity and authorization semantics |
| Versioned vendor path | No implicit global version substitution: endpoint contracts differ (`2.0`, `2026-01`, `2026-04`, `2026-07`) | Domain owner verifies route and payload |
| Public gateway contract | Proposed `core.v1` explicit version; negotiate before mounting | Foundation Manager and all consumer owners |

## Proposed standardized error envelope (NOT ACTIVE)

```json
{
  "error": {
    "code": "LIGHTSPEED_NETWORK",
    "message": "Lightspeed connection unavailable.",
    "retryable": true,
    "outcome": "not_written",
    "correlationId": "server-generated-id"
  }
}
```

This is a design proposal only. The gateway must never expose upstream tokens, request payloads, vendor PII, or raw response bodies. `outcome` must be `not_written`, `unknown`, or `verified`; a transport `mayHaveWritten` result can only be mapped to `unknown` until readback verifies it. Do not claim an HTTP 4xx means a write definitely did not execute. Domain-specific errors remain domain-owned.

## Compatibility and integration gates

1. Obtain Foundation Manager agreement on public `core.v1` envelope and ownership. Never silently change an existing route.
2. Review PR #51 fix and merge strategy with PR #32; verify final base ancestry and full current-head checks before any integration recommendation.
3. Reconcile PR #33 with accepted Phase 1 source; preserve all reader pagination, unknown-state, role/permission and audit tests.
4. Write pure offline contract tests first: timeout, 429/502/503/504 GET retry limits; no POST/PUT/PATCH/DELETE automatic retry; numeric and falsely small Content-Length; invalid UTF-8/JSON; cursor/offset loops and limits; unknown write audit and readback.
5. Test existing consumers one at a time using isolated/test tenant read-only fixtures. No customer/product/stock/credit/sales/PO write trials.
6. Never route the gateway until Foundational Security grants, real tenant read acceptance, regression tests and explicit deployment approval exist.

## Known exception requiring explicit design

Certain X-Series inventory **reads use HTTP POST**. A generic transport POST allow-list cannot infer read-only semantics; design and review a narrowly scoped server-only endpoint admission before using those APIs. Keep default mutation denial intact.

## Milestone 1 acceptance

- Documentation and offline tests only, on an isolated branch.
- No edits to product/inventory/customer/purchasing business services, no server mounts, no Railway config, no migrations.
- Contract decisions and test evidence recorded in `Tawgod/Hobby-Corner:main/handoffs/core-api-foundation.md`.
