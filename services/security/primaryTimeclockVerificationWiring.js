import {createPrimaryTimeclockCanonicalReader} from './primaryTimeclockCanonicalReader.js';
import {createPrimaryEmployeeIdentityDiscovery} from './primaryEmployeeIdentityDiscovery.js';
import {createPrimaryEmployeeIdentityRouter} from '../../routes/primaryEmployeeIdentity.js';

// Composition ONLY. The application must mount the returned router explicitly.
// Test-mode gate prevents accidental production exposure while first real
// employee acceptance and Owner commissioning remain incomplete.
// Do not point this at a synthetic identity, or construct it with a browser
// credential, request-selected employee ID, or admin role assertion.
export function createPrimaryTimeclockVerificationWiring({
  staffAuth, timeclockIdentity, checkOwnerAssignment,
  environment, enabled=false, now=()=>Date.now()
}={}) {
  if (environment!=='test' ||
      typeof staffAuth?.verifyBoundEmployee!=='function' ||
      typeof timeclockIdentity?.authorize!=='function' ||
      typeof checkOwnerAssignment!=='function' ||
      typeof now!=='function' ||
      typeof enabled!=='boolean') {
    throw new TypeError('Test-only trusted staff, Timeclock and Owner adapters required.');
  }
  const canonical=createPrimaryTimeclockCanonicalReader({timeclockIdentity});
  const identityDiscovery=createPrimaryEmployeeIdentityDiscovery({
    verifyBoundEmployee:request=>staffAuth.verifyBoundEmployee(request),
    verifyCanonicalTimeclockEmployee:canonical.verifyCanonicalTimeclockEmployee,
    checkOwnerAssignment:({employeeId})=>checkOwnerAssignment({employeeId}),
    now
  });
  // The "enabled" switch applies only to the factory-built route. It
  // cannot grant Owner appointment or enable a credential enrollment route.
  const router=createPrimaryEmployeeIdentityRouter({identityDiscovery,enabled});
  return Object.freeze({router});
}
