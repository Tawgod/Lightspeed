import {createCoreOperationsRouteAdmission} from './coreOperationsRouteAdmission.js';

// Public staging enforcement deliberately accepts NO synthetic sessions,
// fake employee headers, canned service keys, or in-browser Owner role.
// Synthetic positive-access fixtures live ONLY in Node tests, never in
// Railway runtime. This is not a production guard configuration.
export function createIsolatedStagingCoreAdmission({env=process.env}={}){
  if(!env || typeof env!=='object')throw new TypeError('Environment configuration required.');
  const enabled=env.HC_CORE_SECURITY_STAGING_ENABLED;
  if(enabled==null||enabled===''||enabled==='false')return null;
  if(enabled!=='true')throw new Error('Invalid staging guard flag; use true or false.');
  if(env.NODE_ENV!=='staging' ||
     env.HC_PUBLIC_BASE_PATH!=='/HobbyCorner' ||
     !String(env.DATABASE_URL||'').trim()){
    throw new Error('Core guard requires the approved isolated staging environment and database.');
  }
  const requiredOff=[
    'SPECIAL_ORDERS_LIVE_MODE',
    'SPECIAL_ORDERS_ALLOW_MIGRATION',
    'SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES',
    'SCANNER_ENABLED',
    'SCANNER_TEST_CREATION_ENABLED',
    'HC_ADMIN_NAV_ENABLED'
  ];
  if(requiredOff.some(name=>env[name]!=='false')){
    throw new Error('Staging guard requires explicit live integration kill switches.');
  }
  const prohibitedCredentials=[
    'LIGHTSPEED_DOMAIN','LIGHTSPEED_TOKEN','DISCORD_TOKEN',
    'SPECIAL_ORDERS_ADMIN_KEY','SCANNER_SERVICE_SECRET',
    'SCANNER_SESSION_SECRET','HC_OWNER_STAGING_DATABASE_URL',
    'HC_OWNER_TIMECLOCK_SERVICE_SECRET'
  ];
  if(prohibitedCredentials.some(name=>String(env[name]||'').trim())){
    throw new Error('Staging guard must not run with business or Owner credentials.');
  }
  // No approvedRoutes, staffAccess or service verifier means all business
  // requests fail 403 before reaching DB/vendor endpoints. Health and
  // pre-existing auth-check remain outside the guard (503 when unconfigured).
  return createCoreOperationsRouteAdmission({
    approvedRoutes:[]
  });
}
