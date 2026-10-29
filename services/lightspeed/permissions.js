// Hobby Corner shared Lightspeed operation authorization.
// READ permissions match current Timeclock-backed Scanner lookup (active + canLookup).
// WRITES stay disabled unless a trusted backend grant function authorizes the exact
// operation. A browser-supplied role, employee ID, claim, or PIN never grants access.
// Current Core Operations edits remain untouched until a separate migration.
export const LIGHTSPEED_OPERATION_ACCESS = Object.freeze({
  'customers.search': Object.freeze({ mode: 'read', employeeFlag: 'canLookup' }),
  'products.exact': Object.freeze({ mode: 'read', employeeFlag: 'canLookup' }),
  'inventory.read': Object.freeze({ mode: 'read', employeeFlag: 'canLookup' }),
  'purchase-orders.read': Object.freeze({ mode: 'read', employeeFlag: 'canLookup' }),
  'sales.read': Object.freeze({ mode: 'read', employeeFlag: 'canLookup' }),
  'fulfillments.read': Object.freeze({ mode: 'read', employeeFlag: 'canLookup' }),
  'store-credit.read': Object.freeze({ mode: 'read', employeeFlag: 'canLookup' }),
  'products.create': Object.freeze({ mode: 'write' }),
  'products.update': Object.freeze({ mode: 'write' }),
  'inventory.adjust': Object.freeze({ mode: 'write' }),
  'purchase-orders.write': Object.freeze({ mode: 'write' }),
  'sales.write': Object.freeze({ mode: 'write' }),
  'store-credit.write': Object.freeze({ mode: 'write' }),
  'consignment.write': Object.freeze({ mode: 'write' }),
  'admin.manage': Object.freeze({ mode: 'write' })
});

// The policy passes *server-verified* employee/service identities here,
// not browser-provided role strings or self-declared capability lists.
export function createLightspeedPermissionChecker({
  // An optional trusted server-only grant function, e.g. a future Timeclock
  // per-operation permission service with separately audited administrator grants.
  employeeWriteGrant,
  serviceGrant
} = {}) {
  if (employeeWriteGrant !== undefined && typeof employeeWriteGrant !== 'function') {
    throw new TypeError('Employee write grant adapter must be a function.');
  }
  if (serviceGrant !== undefined && typeof serviceGrant !== 'function') {
    throw new TypeError('Service grant adapter must be a function.');
  }
  return async function checkPermission({ identity, type, operation, mode, environment }) {
    const defined = Object.prototype.hasOwnProperty.call(LIGHTSPEED_OPERATION_ACCESS, operation)
      ? LIGHTSPEED_OPERATION_ACCESS[operation] : null;
    if (!defined || defined.mode !== mode || !['test','production'].includes(environment) ||
        !identity?.id || identity.active !== true) return false;

    if (type === 'service') {
      // A service-to-service identity is not an employee and must have an
      // explicit separately verified operation grant. No role-name fallback.
      return typeof serviceGrant === 'function' &&
        await serviceGrant({ identity, operation, mode, environment }) === true;
    }
    if (type !== 'employee') return false;

    if (mode === 'read') {
      // Scanner/PO Companion existing active employee lookup contract.
      return identity[defined.employeeFlag] === true;
    }
    // Timeclock canApprove currently means Scanner test review approval,
    // NOT permission to change production Lightspeed products or credit.
    return typeof employeeWriteGrant === 'function' &&
      await employeeWriteGrant({ identity, operation, environment }) === true;
  };
}
