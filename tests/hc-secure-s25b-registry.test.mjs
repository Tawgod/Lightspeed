import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateSyntheticAuthorization} from './fixtures/hc-secure-s25b-evaluator.mjs';
const base={
  "fixtureOnly": true,
  "now": 1000,
  "actor": {
    "id": "employee-fixture",
    "realm": "employee",
    "active": true
  },
  "session": {
    "actorId": "employee-fixture",
    "active": true,
    "expiresAt": 2000,
    "revoked": false,
    "locked": false,
    "siteVerified": true,
    "deviceVerified": true,
    "method": "timeclock-pin"
  },
  "effects": [
    {
      "operation": "catalog.product.cost.modify",
      "scope": {
        "tenant": "fixture",
        "environment": "test",
        "location": "store-a",
        "resource": "item-1",
        "field": "cost"
      },
      "registryState": "synthetic-approved",
      "assurance": "on-site-business",
      "approvalRequired": false
    }
  ],
  "grants": [
    {
      "operation": "catalog.product.cost.modify",
      "scope": {
        "tenant": "fixture",
        "environment": "test",
        "location": "store-a",
        "resource": "item-1",
        "field": "cost"
      },
      "expiresAt": 2000,
      "revoked": false
    }
  ],
  "restrictions": []
};
const cases=[
  [
    "active on-site session without repeated PIN or MFA",
    {},
    true,
    "synthetic-allow"
  ],
  [
    "inactive employee",
    {
      "actor": {
        "id": "employee-fixture",
        "realm": "employee",
        "active": false
      }
    },
    false,
    "session"
  ],
  [
    "wrong session actor",
    {
      "session": {
        "actorId": "other",
        "active": true,
        "expiresAt": 2000,
        "revoked": false,
        "locked": false,
        "siteVerified": true,
        "deviceVerified": true,
        "method": "timeclock-pin"
      }
    },
    false,
    "session"
  ],
  [
    "expired session",
    {
      "session": {
        "actorId": "employee-fixture",
        "active": true,
        "expiresAt": 1000,
        "revoked": false,
        "locked": false,
        "siteVerified": true,
        "deviceVerified": true,
        "method": "timeclock-pin"
      }
    },
    false,
    "session"
  ],
  [
    "locked session",
    {
      "session": {
        "actorId": "employee-fixture",
        "active": true,
        "expiresAt": 2000,
        "revoked": false,
        "locked": true,
        "siteVerified": true,
        "deviceVerified": true,
        "method": "timeclock-pin"
      }
    },
    false,
    "session"
  ],
  [
    "revoked session",
    {
      "session": {
        "actorId": "employee-fixture",
        "active": true,
        "expiresAt": 2000,
        "revoked": true,
        "locked": false,
        "siteVerified": true,
        "deviceVerified": true,
        "method": "timeclock-pin"
      }
    },
    false,
    "session"
  ],
  [
    "network qualification lost",
    {
      "session": {
        "actorId": "employee-fixture",
        "active": true,
        "expiresAt": 2000,
        "revoked": false,
        "locked": false,
        "siteVerified": false,
        "deviceVerified": true,
        "method": "timeclock-pin"
      }
    },
    false,
    "site-or-assurance-review"
  ],
  [
    "unapproved phone",
    {
      "session": {
        "actorId": "employee-fixture",
        "active": true,
        "expiresAt": 2000,
        "revoked": false,
        "locked": false,
        "siteVerified": true,
        "deviceVerified": false,
        "method": "timeclock-pin"
      }
    },
    false,
    "site-or-assurance-review"
  ],
  [
    "off-site assurance not frozen",
    {
      "session": {
        "actorId": "employee-fixture",
        "active": true,
        "expiresAt": 2000,
        "revoked": false,
        "locked": false,
        "siteVerified": false,
        "deviceVerified": true,
        "method": "strong"
      }
    },
    false,
    "site-or-assurance-review"
  ],
  [
    "missing permission",
    {
      "grants": []
    },
    false,
    "missing-grant"
  ],
  [
    "expired grant",
    {
      "grants": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 1000,
          "revoked": false
        }
      ]
    },
    false,
    "missing-grant"
  ],
  [
    "revoked grant",
    {
      "grants": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": true
        }
      ]
    },
    false,
    "missing-grant"
  ],
  [
    "explicit restriction beats grant",
    {
      "restrictions": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    false,
    "restriction"
  ],
  [
    "scope mismatch",
    {
      "grants": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-b",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    false,
    "missing-grant"
  ],
  [
    "no cross-scope union",
    {
      "grants": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-b",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        },
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "description"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    false,
    "missing-grant"
  ],
  [
    "unknown scope",
    {
      "effects": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "unknown",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": false
        }
      ]
    },
    false,
    "unknown-effect"
  ],
  [
    "wildcard grant not supported",
    {
      "grants": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "*",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    false,
    "invalid-policy"
  ],
  [
    "unresolved alias cannot be evaluated",
    {
      "effects": [
        {
          "operation": "products.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "alias-review",
          "assurance": "on-site-business",
          "approvalRequired": false
        }
      ]
    },
    false,
    "unknown-effect"
  ],
  [
    "PO cost does not grant catalog cost",
    {
      "grants": [
        {
          "operation": "purchasing.po.line.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    false,
    "missing-grant"
  ],
  [
    "both cost effects require both grants",
    {
      "effects": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": false
        },
        {
          "operation": "purchasing.po.line.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": false
        }
      ]
    },
    false,
    "missing-grant"
  ],
  [
    "both cost effects with both grants",
    {
      "effects": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": false
        },
        {
          "operation": "purchasing.po.line.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": false
        }
      ],
      "grants": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        },
        {
          "operation": "purchasing.po.line.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    true,
    "synthetic-allow"
  ],
  [
    "security permission changes are not PIN-only",
    {
      "effects": [
        {
          "operation": "security.permissions.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": false
        }
      ],
      "grants": [
        {
          "operation": "security.permissions.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    false,
    "security-assurance-review"
  ],
  [
    "approval contract not frozen",
    {
      "effects": [
        {
          "operation": "catalog.product.cost.modify",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": true
        }
      ]
    },
    false,
    "approval-contract-review"
  ],
  [
    "no fixture opt-in",
    {
      "fixtureOnly": false
    },
    false,
    "invalid-fixture"
  ],
  [
    "service realm not human PIN",
    {
      "actor": {
        "id": "employee-fixture",
        "realm": "service",
        "active": true
      }
    },
    false,
    "session"
  ],
  [
    "refund uses valid session",
    {
      "effects": [
        {
          "operation": "sales.payments.reverse",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": false
        }
      ],
      "grants": [
        {
          "operation": "sales.payments.reverse",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    true,
    "synthetic-allow"
  ],
  [
    "product creation uses valid session",
    {
      "effects": [
        {
          "operation": "catalog.product.create.execute",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": false
        }
      ],
      "grants": [
        {
          "operation": "catalog.product.create.execute",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    true,
    "synthetic-allow"
  ],
  [
    "store credit uses valid session",
    {
      "effects": [
        {
          "operation": "store-credit.issue",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "registryState": "synthetic-approved",
          "assurance": "on-site-business",
          "approvalRequired": false
        }
      ],
      "grants": [
        {
          "operation": "store-credit.issue",
          "scope": {
            "tenant": "fixture",
            "environment": "test",
            "location": "store-a",
            "resource": "item-1",
            "field": "cost"
          },
          "expiresAt": 2000,
          "revoked": false
        }
      ]
    },
    true,
    "synthetic-allow"
  ]
];
for(const [name,patch,allowed,reason] of cases) test(name,()=>assert.deepEqual(evaluateSyntheticAuthorization({...base,...patch}),{allowed,reason}));
test('registry candidate covers all 213 source rows and is not executable policy',()=>{const m=JSON.parse(readFileSync(new URL('../docs/security/permission-registry-candidate.json',import.meta.url),'utf8'));assert.equal(m.status,'DESIGN_ONLY_NOT_RUNTIME');assert.equal(m.rows.length,213);const refs=new Set(m.rows.map(r=>r.ref));assert.equal(refs.size,213);const ids=new Set(m.operations.map(o=>o.id));assert.equal(ids.size,m.operations.length);for(const row of m.rows)for(const op of row.operations){if(op.candidate){assert.ok(ids.has(op.candidate));assert.ok(m.operations.find(x=>x.id===op.candidate).sourceRefs.includes(row.ref));}else assert.equal(op.status,'unresolved');}for(const op of m.operations){assert.equal(op.reviewStatus,'proposed');assert.ok(op.sourceRefs.every(x=>refs.has(x)));}});
