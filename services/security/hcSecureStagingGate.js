// HC Secure standalone staging boundary. No secrets, SQL, I/O or side effects.
// Production Owner launch still uses staging/owner-security-server.js.
const TARGET_PROJECT='120de974-f2e8-46be-9a00-8eb8b1be4cc4';
const TARGET_ENVIRONMENT='8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c';
const TARGET_HOST='secure-hc.timcorp-productions.com';
const DISALLOWED=[
 'DATABASE_URL','LIGHTSPEED_DOMAIN','LIGHTSPEED_TOKEN','DISCORD_TOKEN',
 'SPECIAL_ORDERS_ADMIN_KEY','SCANNER_SERVICE_SECRET',
 'SCANNER_SESSION_SECRET','SCANNER_LOGIN_LIMIT_SECRET',
 'TIMECLOCK_ADMIN_SECRET','OWNER_STAGING_SERVICE_SECRET'
];
const expected={
 NODE_ENV:'test',
 HC_SECURITY_ENV:'isolated-staging',
 HC_OWNER_STAGING_ENABLED:'true',
 HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'1',
 HC_OWNER_STAGING_ORIGIN:'https://'+TARGET_HOST,
 HC_OWNER_STAGING_RPID:TARGET_HOST,
 HC_STAGING_TEST_LOGIN_ENABLED:'false',
 HC_STAGING_PIN_SETUP_ENABLED:'false',
 RAILWAY_PROJECT_ID:TARGET_PROJECT,
 RAILWAY_ENVIRONMENT_ID:TARGET_ENVIRONMENT
};
function privateDatabaseUrl(value){
 let u;
 try{u=new URL(value);}catch{return false;}
 return ['postgres:','postgresql:'].includes(u.protocol) &&
  u.hostname==='hc-secure-postgres-staging.railway.internal' &&
  u.pathname==='/hc_owner_stage_test' &&
  !!u.username && !!u.password && !u.search && !u.hash;
}
export function hcSecureStagingGate(environment={}){
 const issues=[];
 for(const [key,value] of Object.entries(expected))
  if(environment[key]!==value)issues.push(key);
 if(DISALLOWED.some(k=>String(environment[k]??'').trim()))
  issues.push('forbidden_business_or_shared_credentials');
 if(!privateDatabaseUrl(environment.HC_OWNER_STAGING_DATABASE_URL))
  issues.push('dedicated_private_runtime_database');
 if(!String(environment.HC_OWNER_TIMECLOCK_ORIGIN??'').startsWith('https://'))
  issues.push('timeclock_https_origin');
 if(environment.HC_OWNER_TIMECLOCK_ORIGIN==='https://'+TARGET_HOST)
  issues.push('timeclock_is_separate_canonical_service');
 return Object.freeze({ready:issues.length===0,issues:Object.freeze(issues)});
}
