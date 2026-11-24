# S2.5D immutable execution and independent access — offline candidate
Parent accepted #104 fd85fdf662b679d3aa1877cc096fada08b9e0cc6. Additive fixture only. No actual Security interface freeze, grants, production integration or deployment.

Execution effects are immutable across claim, lock, precommit, projection and reconciliation. Approval digest binds only canonical execution effects, actor, tenant, revision and command fingerprint. Independent stage-specific access effects are included in decision binding but not execution approval; read only at projection, inspect only at reconciliation, neither during execution. Every exact tuple must have a current grant and no matching restriction. Access target must correspond to an execution target in this fixture; field may differ. No new approval solely for adding an authorized disclosure field. Current execution grants and approval remain required even on disclosure, conservatively; expiration after commit denies disclosure, never implies rollback. Production policy for historical receipt inspection needs explicit review. Security admin, off-site, service/delegation and Owner exception remain gated. Caller fingerprint and completeness of effects must come from trusted domain derivation; fixture does not prove that, or actual authentication, policy revocation atomicity, signatures, audit, or real approval policy.

## Remaining 19 legacy references: proposed disposition for domain review
No runtime alias activation, no broad grant migration. Each row refers to source refs in #102 manifest. Candidate names are not approved grants.

| Source identifier | Proposed direction | Required exact scope / decision |
|---|---|---|
| products.delete | catalog.product.archive vs catalog.product.delete | Catalog: product/variant, status/revision, dependency checks; hard deletion not implied |
| catalog.references.configure | catalog.reference.create/update/delete individually | Catalog: reference type/id, hierarchy, archive vs delete |
| count.session.manage | inventory.count.session.create/close/cancel individually | Inventory: outlet/session/revision, assigned worker |
| count.review | inventory.count.reconcile vs inventory.review.read/resolve | Inventory: count variance vs discrepancy resolution, evidence/session |
| count.adjust.approve | inventory.adjustment.approve candidate | Inventory: exact adjustment/revision/quantity/cost impact, distinct execute |
| restock.task.manage | inventory.restock.task.create/assign/cancel | Inventory: task/location/revision/assignee |
| inventory.location.configure | inventory.location.create/update/deactivate; assignment and target separate | Inventory: outlet/shelf/product scope |
| inventory.reserve | inventory.allocation.create candidate only | Inventory: reservation vs committed allocation, product/outlet/order/quantity |
| inventory.release | inventory.allocation.release candidate only | Inventory: exact original allocation and revision |
| inventory.receive | inventory.receipt.confirm vs inventory.receipt.execute | Inventory/Purchasing: physical evidence vs stock effect, PO line/product/outlet/quantity |
| inventory.transfer | inventory.transfer.dispatch and receive | Inventory: source and destination, transfer/line/revision, distinct physical effects |
| sales.return | sales.returns.execute plus applicable independent effects | Customer/Inventory: return/sale/line/customer/outlet/quantity, payment/credit/stock effects |
| payments.refund | sales.payments.reverse candidate; separate refund if semantics differ | Customer: original payment, amount/currency, provider status |
| deposits.modify | sales.deposit.collect/reverse/convert individually | Customer: deposit/sale/customer/amount, credit effect if applicable |
| data.export | domain export plus actual read field scopes | Core/domains: purpose, dataset, destination, field and tenant; no blanket read |
| workflow.jobs.configure | jobs.configure with domain scope candidate | Core/Customer: job type, schedule, effect set, delegate separate |
| workflow.jobs.execute | jobs.execute with domain scope candidate | Core/Customer: exact run, authority, effects; retry not automatic |
| workflow.audit.read | audit.read with Customer domain scope candidate | Core/Customer: event/resource and field projection, no security audit implied |
| inventory.adjust | inventory.adjustment.propose/approve/execute/readback as actual effect | Inventory: adjustment/revision/product/outlet/quantity; no broad mapping |

## Exact scope extension requirements (proposal)
Current fixture tuple tenant/environment/location/resourceType/resourceId/field is minimal. Domain must supply immutable typed target set, actual operation effects, resource revision, quantity/amount/currency where applicable, supplier/customer/order relationships and purpose/audience for disclosures. Do not encode monetary thresholds as arbitrary field strings. Multiple targets require all scopes; cross-store transfer needs both ends; no wildcard or cross-grant scope synthesis. Whole-store default is explicit authorized existing-store locations, not future outlets. Ordinary authorized cost and customer contact/notes/financial read defaults retained, individual restrictions override; exclude raw payment credentials and separate export. New resources require stable intended IDs or reviewed creation scope, not missing ID bypass. Read/inspection of related targets not in execution set needs a separate trusted derivation contract; this fixture denies it. Role bundles, service scopes, expiry, approval thresholds and real decision transport/fencing remain unapproved.

S2.1 stays separately gated by Timeclock owner review and private secret commissioning; no deployment or credential changes. Manager/domain review required for all 19 proposed dispositions and exact scope extensions before registry freeze. One capped dependency-free CI runs 51 inherited and 20 new tests; record actual logs in handoff.
