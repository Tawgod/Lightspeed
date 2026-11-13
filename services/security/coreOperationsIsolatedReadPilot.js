import {createStaffBoundSessionAdapter,createStaffSecurityAccessGate}
  from './staffSecurityBridge.js';
import {createCoreOperationsRouteAdmission}
  from './coreOperationsRouteAdmission.js';

// Unmounted, DEVELOPMENT-ONLY pilot composition: intentionally different
// from the public PR #63 Railway zero-grant guard. Do not inject this into
// server.js, enable it on an existing staging service or use real employees.
// No write route, service identity, Owner role or WebAuthn enrollment is added.
const READ_ROUTES=Object.freeze([
  Object.freeze({source:'special-orders.js',method:'GET',path:'/orders',
    audience:'employee',operation:'special-orders.read'}),
  Object.freeze({source:'special-orders.js',method:'GET',path:'/stats',
    audience:'employee',operation:'special-orders.read'})
]);
const MUST_BE_FALSE=[
  'SPECIAL_ORDERS_LIVE_MODE','SPECIAL_ORDERS_ALLOW_MIGRATION',
  'SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES','SCANNER_ENABLED',
  'SCANNER_TEST_CREATION_ENABLED','HC_ADMIN_NAV_ENABLED'
];
const MUST_BE_ABSENT=[
  'LIGHTSPEED_DOMAIN','LIGHTSPEED_TOKEN','DISCORD_TOKEN',
  'SPECIAL_ORDERS_ADMIN_KEY','HC_OWNER_STAGING_DATABASE_URL',
  'HC_OWNER_TIMECLOCK_SERVICE_SECRET'
];

export async function createIsolatedCoreEmployeeReadPilot({
  environment=process.env,staffAuthGateway,workstations,grantReader
}={}){
  if(!environment || environment.NODE_ENV!=='test' ||
      environment.HC_SECURITY_ENV!=='isolated-staging' ||
      environment.HC_PUBLIC_BASE_PATH!=='/HobbyCorner' ||
      environment.HC_CORE_EMPLOYEE_PILOT_ENABLED!=='true' ||
      environment.HC_STAGING_TEST_LOGIN_ENABLED!=='true' ||
      environment.HC_CORE_SECURITY_STAGING_ENABLED==='true' ||
      MUST_BE_FALSE.some(key=>environment[key]!=='false') ||
      MUST_BE_ABSENT.some(key=>String(environment[key]||'').trim())){
    throw new Error('Pilot requires an independent, credential-free isolated test environment.');
  }
  if(typeof staffAuthGateway?.verifyBoundEmployee!=='function' ||
     typeof workstations?.verifyWorkstation!=='function' ||
     typeof grantReader?.verifyReadOnly!=='function' ||
     typeof grantReader?.checkPermission!=='function'){
    throw new TypeError('Signed staff, registered station and SELECT-only grant adapters required.');
  }
  if(await grantReader.verifyReadOnly()!==true){
    throw new Error('Pilot permission database must use a separate SELECT-only runtime role.');
  }
  const staffSession=createStaffBoundSessionAdapter({staffAuth:staffAuthGateway});
  const staffAccess=createStaffSecurityAccessGate({
    staffSession,
    // No MFA/passkey enrollment or privileged operation permitted in this
    // pilot. A forged TOTP/passkey header is never a trusted proof.
    mfa:{verify:async()=>null},
    verifyWorkstation:workstations.verifyWorkstation,
    checkPermission:grantReader.checkPermission
  });
  // Exact two read routes are hardcoded here. Never derive approvals from
  // review-pending proposals or a user-supplied policy manifest.
  const gate=createCoreOperationsRouteAdmission({
    approvedRoutes:READ_ROUTES,staffAccess
  });
  return Object.freeze({authorize:gate.authorize,middleware:gate.middleware});
}
