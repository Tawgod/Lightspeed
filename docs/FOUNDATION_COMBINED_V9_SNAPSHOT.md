# Foundation V9 combined candidate (not approved)
Parent V8 8848f47b71286e177fd483feb94af37b795fead7; expected 543 tests (471+2+12+25+18+15), 56 files. Exact Security #121 ee4e417fcfc1ae4358b0e256ccd8a8dee9073ecd, separate checkout and original fixture hashes. Core #125 48689e0084646c42df6e3533f49257d740773ba2; Customer #126 adba73b6f40d7022ffcb5e34e7b911b8161a4125; Catalog #127 5bd4521cce10ec7c5abe9c50bc94090150840864; Inventory #128 083ea08ef4a0cdbf4cfe6892e89048d33c8fc22e; Purchasing #129 f88d8513380755248d93b59374e5361f2a3aa215. Targeted actual logs 72/93/120/95/106 passing, zero fail/skip/cancel/todo. Four identical Core service files included once. No production effects; synthetic evidence only. No Security successor, Operations, draft persistence, new grants, runtime writer or migration included. Remaining cross-domain semantics (Purchasing variant and credit review, global financial dedup, real physical linkage) separately gated. Original draft PRs preserved. Owner approval required after combined CI.

| PR | Path | Exact Git blob |
|---|---|---|
| #125 | .github/workflows/hc-core-api-m9.yml | 0503a009b56cef333c62251259ab092f5796d066 |
| #125 | docs/CORE_API_M9_ADOPTION.md | d12303df6e3b92e97624bab1841b61a5df070349 |
| #125 | docs/HC_DRAFT_WORKSPACE_0_1.md | a49a8dcb0689a73b07d7a9916c7447127106b5d0 |
| #125 | tests/core-api-m8-postgres.test.mjs | 7f86e825eb50ab4cbbdafe80f07f977faa3dbc0c |
| #125 | services/lightspeed/localTransactionM7.js | a6ba8cfcd6d43b8c777a877703ef16b611631797 |
| #125 | services/lightspeed/localTransactionM8Internal.js | 22acfb89f28581fcc28c3f05b9af89a3f30038c2 |
| #125 | services/lightspeed/remoteMutationM7.js | b84bbd68fef175c3314ce32b276499baed0ecf15 |
| #125 | services/lightspeed/remoteMutationM8Internal.js | 40302dd3c0db309200f0d3525275294e28ebdd41 |
| #126 | .github/workflows/hc-customer-sales-m11.yml | 655eb1ddd592a539010d169789a9f5a7bb9ca463 |
| #126 | docs/CUSTOMER_SALES_M11.md | 49cb25d958040e95607c1c9024c85f11cb2cc420 |
| #126 | services/lightspeed/customerSalesM11.js | a1140ea8ec571c63dca31d07377952ea0e73c28e |
| #126 | tests/customer-sales-m11-postgres.test.mjs | 1b4585fb5ba8ff012e2e174d1ae2d2401c258fbc |
| #127 | .github/workflows/hc-catalog-v8-m11.yml | 01ecde69d8266620b2da3dfc8008e4858ffdf4ec |
| #127 | docs/PRODUCT_CATALOG_V8_M11.md | 994113e1a1fd836afb939005da741bec04fad025 |
| #127 | tests/product-catalog-v8-m11.test.mjs | fab881eb44f1c2c00390b0e5c802230d666ca6cf |
| #128 | .github/workflows/hc-inventory-m11.yml | 9f0791738d8eb711e6cce78ee84efa5168192e87 |
| #128 | docs/INVENTORY_M11_ADOPTION.md | 667466b18d257b6db5f1c066f6337a60727aa2fb |
| #128 | tests/inventory-m11-postgres.test.mjs | 355bbd1d3ef274ff600997c763212d57b7914c09 |
| #129 | .github/workflows/hc-purchasing-p11-v8.yml | 508a96bc2740808674227db08487812038ace9fe |
| #129 | docs/PURCHASING_P11_V8.md | 2e386b669072ed54d4e38c18f0b7dfc988762593 |
| #129 | services/lightspeed/invoicePersistenceM8.js | ea1fa4f85cb3d391d5858342f5bfe5eb28999ee2 |
| #129 | tests/purchasing-foundation-m11-postgres.test.mjs | 45708ccc712f2ba5d8147369393b7f43cf937c1c |
