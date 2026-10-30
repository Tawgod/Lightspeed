import { createLightspeedPolicy } from './policy.js';

// Bridges the existing Timeclock-backed staff-auth gateway.
// No employee is authenticated based on a caller-supplied ID, role, or PIN alone.
export function createStaffLightspeedPolicy({
  verifyEmployeeRequest, checkPermission,
  verifyService, writesAllowed = false, productionWritesAllowed = false
} = {}) {
  if (typeof verifyEmployeeRequest !== 'function') throw new TypeError('Staff-auth verifier required.');
  return createLightspeedPolicy({
    verifyEmployee: async principal => {
      if (!principal?.request) throw new Error('Employee request context required.');
      const verified = await verifyEmployeeRequest(principal.request);
      if (!verified?.id || verified.active === false) throw new Error('Employee session invalid.');
      return { ...verified, active: true };
    },
    verifyService, checkPermission, writesAllowed, productionWritesAllowed
  });
}
export function employeeRequestPrincipal(request) {
  if (!request || typeof request.get !== 'function') throw new TypeError('Express request required.');
  return Object.freeze({ type: 'employee', request });
}
