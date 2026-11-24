# V6 combined test candidate
Parent V5 87f6a94918653a3417ce01205098193eb1ccb35d
- PR #100 Core: 964b84d084c0224b251b3ecef0bb1af30f9cdf22
- PR #101 Catalog: 0c4a28d72b5ee3ebb1d664395dc359fad09f9511
- PR #106 Inventory: d714bab43f66592efec70aff07bf09e38435e006 (tested with exact Core pin)
- PR #103 Customer: 8654430fb458be10cf7a8c47969d7bd238c091db
- PR #107 Purchasing: 698e2b7c772dd333399d1c2dba0871ea0a79f9a8 (only four paths beyond Core pin)
19 distinct workstream paths plus this manifest and branch-scoped workflow. 40 test files; 346 expected tests (299 inherited +15+8+8+8+8). Core included once; only disposable PostgreSQL, synthetic decisions, no live vendor calls, no production routes, no merges or deployments. Security independent. V5 remains approved until combined exact-head validation and explicit owner promotion.
