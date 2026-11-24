# Customer & Sales M6 — sale workflow evidence (internal candidate)

Baseline V3: 098c9e51ea4c3449605ad6951baa8284e126e8d4. No live activation.

## Read contract
Use createSaleWorkflowRead({sales,fulfillments,readDepositEvents,readWorkOrders}) in services/lightspeed/saleWorkflowEvidence.js. Reuses existing sale detail and per-sale fulfillment GET readers; optional correlationId propagates through both and injected feature readers. Existing reader methods and output envelopes remain unchanged when trace omitted. No new client, persistence, authorization engine or route.

Normalized payment amounts and quantities are exact decimal strings (no floating-point conversion); invalid or conflicting aliases reject. Missing arrays are unknown; explicit empty records are not proof of zero balances. Sale lines and fulfillment lines retain exact IDs; mismatched product association rejects, orphaned lines are flagged, missing sale-line coverage is unknown. Picked, packed, fulfilled and customer pickup are distinct; no pickup quantity, stock effect or deposit balance is inferred. Payments are not classified as deposits. Explicit injected deposit events (eventId, saleId, kind, nonnegative amount, currency) and work-order records (workOrderId, saleId, state) are only supplied evidence; no event reconciliation or historical completeness claimed. Default empty providers are unconnected, not authoritative absence. Coverage always incomplete; per-sale fulfillment single page. No totals or execution eligibility. No raw payment/card/contact records.

## Source and parity boundaries
Pinned V3 route audit: routes/orderSplit.js lines 69–180 uses existing payment aliases and fulfillment line IDs; routes/workOrderCombine.js lines 24–40 and 74–170 summarizes payments and pending/parked sales; routes/depositConversion.js lines 82–223 reduces payments and posts credit. None changed. Source evidence identifies compatibility risks: first-result fallback in invoice matching, treating missing amounts as zero, treating payments as deposits, state/status aliases and unverified line quantities. Current conservative projection deliberately rejects simultaneous competing collection aliases and differing state/status values; numeric vendor amounts are not accepted without source validation. This is not a drop-in replacement or vendor schema confirmation. Real deposit/work-order provider, timestamps, provenance, reversals, coverage and partial pickup evidence remain unverified.

## Mandatory cross-tool security
Security owns exact actor/operation/resource/field/environment grants, expiry and revocation. Core owns enforcement integration and audit. The M6 fixture invokes existing core.v1 executor with a synthetic verifier and proposed sales.workflow.read and sales.deposit.collect labels. It denies the latter at six simulated entrypoint labels and rechecks revoked read access; there is no actual mutation callback, no real route wiring and no approved grant name. It is not evidence of production permission enforcement. Do not call a read executor to execute a mutation.

Proposed operation mapping for coordination (not registry approval):
- Customer lookup/identity/consent read, sale/work-order/fulfillment read: separately scoped read grants with field/resource restrictions.
- Customer creation/update/linking, consent change, product creation/update/cost change, sale creation/update/split/recall/combine, deposit collection/reversal, payment modification, pickup confirmation, return/void, credit posting/reversal: distinct underlying operations, not tool grants.
- Deposit conversion combines payment modification, sale update and credit posting; require all applicable exact grants before any effect and recheck at actual execution. Split/Recall and Preorders cannot bypass underlying customer/product/sale/financial permissions. Imports, bulk, direct APIs, queued tasks and automation use same canonical decisions. Approval cannot substitute for execution-time authorization. A service account or broad tool grant cannot override denied underlying operation. Actual mapping, grant names, all-of enforcement, durable audit, replay and atomicity need Core/Security agreement before implementation.
- All active employees can view wholesale costs under ordinary employee product access; cost modification is separate. Do not infer anonymous access or modify Catalog-owned projections.

## Validation
Run node --test tests/customer-sales-m6.test.mjs in exact checkout. Seven new groups; local isolated run 7/7 on hash-verified changed files and Core executor, with minimal local stand-ins for inherited client and collection modules. No full regression or live calls. Add this suite to the next manager combined validation; no new CI workflow.

## Stop gate
Manager review of evidence semantics and operation map, Core/Security approved scoped grant contract, source/provider provenance and feature parity. M7 returns and store credit remains separately gated. No credit posting, payment collection, account linking, route mount, production access, merge or deployment.
