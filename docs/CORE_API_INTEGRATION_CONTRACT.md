# Core API integration candidate — manager review required

Baseline: PR #78, 71a1cd6e312ed52efc1e9af9da85db6b02e3756c. Draft PR #83. No mounted routes or live calls.

## Read contract
Server-owned operation and callback; environment fixed at construction. Security supplies authorizeRead({operation, context, mode:'read', environment, correlationId}) and must independently verify active identity and exact grant. Only literal true admits. No identity claims are trusted by Core. Adapter contract awaits Security/manager acceptance.
Success: {status:200, body:{version:'core.v1',readOnly:true,correlationId,data}}. Failure: {status,body:{version:'core.v1',readOnly:true,correlationId,error:{code,message,retryable}}}. Denial 403, unknown failures 503, typed vendor failures 502. Domain projections must precede output; no raw vendor records or PII by default. Domain-specific status mappings and mutation outcomes remain separate proposals, not frozen interfaces. No automatic retries of writes.

## Pagination and correlation
Collection reads return complete bounded results or throw; preserve original endpoint and all non-pagination query values including repeats and leading zeros. Explicit continuation controls permitted: page, page_size, offset, after, cursor. Contradictory next links or boolean flags fail closed. This is conservative: vendor links omitting filters, alternate token names or contradictory metadata require explicit offline fixture review before support. No snapshot consistency guarantee. Optional correlationId forwarded on every page to existing transport X-Request-ID. Domain callers must opt in; no global state or domain rewrites.

## POST-for-read admission proposal (not implemented)
Inventory may require a vendor POST read. Keep generic transport unchanged: POST denied by default, no mutation opt-in for reads. Before implementing, obtain exact API version/path, request schema and documented non-mutating semantics from Inventory and vendor documentation. Require dedicated server-owned operation, fixed path, allowlisted body schema and size, exact Security read grant, no arbitrary URL or method, bounded response, no automatic retry until idempotent read semantics verified. Reject all other POSTs. Synthetic negative tests and manager approval before any live read test. Do not reuse a write-capable transport for this purpose.

## Integration gates
Manager freeze of envelope and shared error taxonomy; Security exact-grant adapter; domain safe projections and correlation propagation; full shared regression including disposable PostgreSQL; controlled read-only tenant evidence separately authorized. No production merge/deploy or database migration.
