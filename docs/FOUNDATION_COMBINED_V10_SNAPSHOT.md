# Foundation V10 isolated combined candidate
Parent V9 2b05b49ee24b7fc61c95e9e4241d863101fc52b6; expected 606 tests (543+6+12+15+15+15), 60 explicit files. Not approved until exact CI and owner approval. Original draft PRs #131 ac814870de1c5352639602006b146c66cb5fd0c0, #134 3e40328a1bcbe76f6daf5271c7be3faddf238134, #135 5a9273e15dfe90ba0280d1526afaf0205a7e4ff2, #136 6df17cb382d16888b499a83735c350908940e740, #137 6ccfc2b1da76b5a7dce2d49fdd945d4fd70c03f2 remain unmerged. Core module included once. HC-AUTHZ/0.1.0 #121 ee4e417fcfc1ae4358b0e256ccd8a8dee9073ecd exact separate checkout and original three hashes; Security #138 and Operations #132 independent, not included. Bounded synthetic domain adapters only; actual identity, trusted original evidence, rich scope, distributed fences, provider effects, production migrations and D1 drafts remain gated. No production change.

## Exact source blobs
- .github/workflows/hc-core-api-m10.yml 57e3a9561ab894cf43f717c298927ce6c8d63f91
- docs/CORE_API_M10_ADAPTER.md 43baa01869fb02eaed584a695a9e8529a81fdaa2
- docs/HC_DRAFT_D0_RECONCILIATION.md 6a23c795ae3cc2631c182aadb7f02d4198e58ecf
- services/lightspeed/domainAdapterM10.js 70f5a4cfc3f111f83c493b8fe5f6f3dfb5e62fa4
- tests/core-api-m8-postgres.test.mjs 6076f7da9ab527a0ba84361a7705330f549675c1
- .github/workflows/hc-catalog-v9-m12.yml ab0f3cb03ecefb9823e42d0b8d7b0801ff4fe45b
- docs/PRODUCT_CATALOG_V9_M12.md 2e62073f3020e9a4aec39f754f6288153b69c78f
- services/lightspeed/productCatalogAdapterM12.js 1f9928af911b53c280233314fd770d1d67c23711
- tests/product-catalog-v9-m12.test.mjs 6a07b02a837e238a098c6ee5773d87655bb1761b
- .github/workflows/hc-inventory-m12.yml 42ed21be47a0e9a7dc5384385cb723dd431df9aa
- docs/INVENTORY_M12_ADAPTER.md ddb9807c7beda59ccd5a2d06bb0c7e7c4ce5181c
- services/lightspeed/inventoryAdapterM12.js 1892db866e558380307b6f35ce633215de90a337
- tests/inventory-m12-postgres.test.mjs 9687fd48f0a90920dbdcccd198e56ea91762541c
- .github/workflows/hc-purchasing-p12-v9.yml b67f0a4d7b05921fbb49b0ce24abc29e7400e037
- docs/PURCHASING_P12_V9.md bcbf9193987c55bca10947c7813660564e4726d6
- services/lightspeed/purchasingAdapterP12.js 7fb421e092df2172247e2bd30a5b46cc45d99be7
- tests/purchasing-foundation-m12-postgres.test.mjs 257826423562922bb537b68cae4e2a6b289e0373
- .github/workflows/hc-customer-sales-m12.yml 431e2c9b50e79298e5d0da92d87070a0b927c17f
- docs/CUSTOMER_SALES_M12.md a5106c3d39454f04695b55ab64d6e4c9669839eb
- services/lightspeed/customerAdapterM12.js a69553da286ce100ed51045515d8214dba3560ae
- tests/customer-sales-m12-postgres.test.mjs 03e5c4094f9c6bf44bb7cae91e27849b70013c84
