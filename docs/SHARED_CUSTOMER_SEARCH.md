# Shared customer search — consumer integration guide (draft)

Status: offline-tested internal backend contract; not mounted, merged or deployed.

Use the existing Core API transport and `createLightspeedCustomersRead({ transport })` from `services/lightspeed/customers.js`. Do not instantiate another vendor HTTP client.

| Method | Result | Purpose |
| --- | --- | --- |
| search(query) | raw row array | bounded paginated search; no identity proof or exhaustive duplicate absence |
| searchFirstPage(query) | { rows, coverage, complete: false } | interactive legacy first-page compatibility; no duplicate absence |
| get(customerId) | existing vendor response envelope | direct customer ID lookup |

Name, email and telephone queries share the existing 2026-04 search URL builder. Direct lookup retains the existing 2.0 endpoint. Explicit customer ID lookup is not free-text ID search. Empty queries do not contact vendor. Transport failures propagate through Core API; malformed first-page responses reject. No search writes.

For minimal identity references and contact match evidence, use the existing opt-in `createCustomerSalesEvidence` with the four approved readers. Match results always require review and are not authority to create or link customers.

## Consumers

Special Orders: first proposed consumer, but do not replace its route with the raw shared service. Its existing customer search shows a single page of 20 and enriches results using a local PostgreSQL customer profile. A future authorized route adapter may consume searchFirstPage(query).rows, preserve ordering and local enrichment, and retain the existing array response. The M3 tests reproduce the initial search URLs and use synthetic local enrichment fixtures, not the actual running route. Malformed response rejection is deliberately stricter than legacy behavior. Review error handling and authorization before switching.

Consignment, Rewards, Preorders, Repairs, Reservations, future customer tools: reuse the same backend reader via approved dependency injection. Choose first-page or bounded paginated search according to the workflow; apply an appropriate field allowlist, and use customer ID references rather than copying local customer records. No dependency on Special Orders is necessary. Customer linkage, consent, feature data and writes remain separate.

## Security and release gates

Raw vendor rows contain personal information. These internal functions do not perform authorization and must not be mounted publicly or called directly from browsers. Consume the Foundational Security approved exact operation grants and Core API safe error envelope before exposing any results; avoid query/PII logging and cache leakage. No automatic customer creation, mutation, or identity link. Validate vendor response shapes, inactive coverage and contact aliases before real consumer acceptance. Do not interpret no search hits as proof a customer does not exist.

Offline test: node --test tests/customer-sales-evidence.test.mjs
