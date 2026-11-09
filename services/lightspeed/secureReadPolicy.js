import {createLightspeedPolicy} from './policy.js';
import {LIGHTSPEED_OPERATION_ACCESS} from './permissions.js';

// DEVELOPMENT-ONLY composition for *future* shared Lightspeed reader mounts.
// The backend injects the established Timeclock + independent workstation/MFA
// assurance gate. This module never accepts a browser employee ID or role.
// Existing operational routes are unaffected until individually migrated.
const VALID_EMPLOYEE = /^[1-9][0-9]{0,17}$/;

export function createSecuredSharedLightspeedReadPolicy({
  staffAccess, checkReadGrant
} = {}) {
  if (typeof staffAccess?.authorize !== 'function' ||
      typeof checkReadGrant !== 'function')
    throw new TypeError('Trusted staff assurance and exact read grants required.');

  return createLightspeedPolicy({
    writesAllowed: false,
    productionWritesAllowed: false,
    // staffAccess.authorize delegates to the existing signed Timeclock session
    // verifier, registered workstation / MFA verifier, and tools.read grant.
    // This adapter does not look at clock-in, shifts, schedules or PTO.
    verifyEmployee: async principal => {
      if (!principal?.request) throw Error('Request required.');
      const admitted = await staffAccess.authorize({
        request: principal.request, action: 'tools.read'
      });
      const id = String(admitted?.employeeId ?? '');
      if (!VALID_EMPLOYEE.test(id) || admitted?.operation !== 'tools.read')
        throw Error('Unverified staff admission.');
      return Object.freeze({id, active:true});
    },
    // Check each canonical Lightspeed operation separately after assurance;
    // tools.read alone cannot silently grant sales, credit or inventory reads.
    checkPermission: async ({identity,type,operation,mode,environment}) => {
      if (type !== 'employee' || mode !== 'read' ||
          !['production','test'].includes(environment) ||
          !VALID_EMPLOYEE.test(String(identity?.id || '')) ||
          identity?.active !== true ||
          LIGHTSPEED_OPERATION_ACCESS[operation]?.mode !== 'read')
        return false;
      return await checkReadGrant({
        employeeId:String(identity.id),operation,environment
      }) === true;
    }
  });
}
