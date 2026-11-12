import {createCoreOperationsRouteAdmission} from './coreOperationsRouteAdmission.js';

// HARD staging-only rollout boundary. No HTTP header, employee role, public
// test PIN or operator-controlled query string can activate this guard.
// The first phase has ZERO approved routes, staff grants and service identities;
// real employee/Owner provisioning and positive-grant tests are separate gates.
const FORBIDDEN_VENDOR_CONFIG=[
 'LIGHTSPEED_DOMAIN','LIGHTSPEED_TOKEN','DISCORD_TOKEN',
 'SPECIAL_ORDERS_ADMIN_KEY','SCANNER_SERVICE_SECRET',
 'SCANNER_SESSION_SECRET','SCANNER_TIMECLOCK_ORIGIN',
 'HC_ADMIN_GRANTS_DATABASE_URL'
];
export function createIsolatedStagingZeroGrantGuard(env=process.env){
 if(env?.HC_STAGING_CORE_GUARD_ENABLED!=='true')return undefined;
 if(env?.NODE_ENV!=='staging'||env?.HC_SECURITY_ENV!=='isolated-staging')
  throw new Error('Staging Core Operations guard refused outside isolated staging.');
 if(FORBIDDEN_VENDOR_CONFIG.some(key=>String(env[key]||'').trim()))
  throw new Error('Staging zero-grant guard refuses inherited production/vendor credentials.');
 if(['SPECIAL_ORDERS_LIVE_MODE','SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES',
      'SPECIAL_ORDERS_ALLOW_MIGRATION','SCANNER_ENABLED','HC_ADMIN_NAV_ENABLED']
  .some(key=>env[key]!=='false'))
  throw new Error('Staging zero-grant guard requires explicitly disabled write/integration flags.');
 // Only the independently verified static source registry and exact-token
 // implementations can later be injected. No fixture grant is exposed here.
 return createCoreOperationsRouteAdmission({approvedRoutes:[]});
}
