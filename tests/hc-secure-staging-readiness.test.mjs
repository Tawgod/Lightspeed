import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOwnerTimeclockStagingConfig}
 from '../services/security/ownerTimeclockStagingBundle.js';
import {validateOwnerStagingDatabaseUrl}
 from '../staging/owner-security-server.js';

// Configuration-only HC Secure migration checks. No SQL, user secrets,
// network, activation, credential issuance, or deployment actions.
const TARGET='secure-hc.timcorp-productions.com';
const ORIGINAL='hc-owner-staging-staging.up.railway.app';
function fixture(){
 const e={
  NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
  HC_OWNER_STAGING_ENABLED:'true',HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'1',
  HC_OWNER_STAGING_ORIGIN:'https://'+TARGET,
  HC_OWNER_STAGING_RPID:TARGET,
  HC_OWNER_TIMECLOCK_ORIGIN:'https://timeclock-production-2bfa.up.railway.app',
  HC_OWNER_STAGING_DATABASE_URL:'postgresql://runtime:test@hc-secure-postgres.railway.internal:5432/hc_owner_stage_test',
  HC_STAGING_TEST_LOGIN_ENABLED:'false',HC_STAGING_PIN_SETUP_ENABLED:'false'
 };
 for(const [i,key] of [
  'HC_OWNER_TIMECLOCK_SERVICE_SECRET','HC_OWNER_SESSION_SECRET',
  'HC_OWNER_THROTTLE_SECRET','HC_OWNER_PASSKEY_SIGNING_SECRET',
  'HC_OWNER_APPROVAL_HMAC_SECRET','HC_OWNER_MFA_SESSION_SECRET'
 ].entries())e[key]=String(i+1).repeat(40);
 e.HC_OWNER_TOTP_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
 return e;
}
test('HC Secure proposed exact origin and RP ID pass strict staging configuration (configuration-only)',()=>{
 const e=fixture();
 assert.deepEqual(validateOwnerTimeclockStagingConfig(e).issues,[]);
 assert.equal(validateOwnerStagingDatabaseUrl(e),e.HC_OWNER_STAGING_DATABASE_URL);
});
test('an Owner credential tied to original host cannot be assumed valid under new RP ID',()=>{
 const e=fixture();
 e.HC_OWNER_STAGING_RPID=ORIGINAL;
 assert.ok(validateOwnerTimeclockStagingConfig(e).issues.includes('owner_https_origin_rpid'));
 e.HC_OWNER_STAGING_RPID=TARGET;
 e.HC_OWNER_STAGING_ORIGIN='https://'+ORIGINAL;
 assert.ok(validateOwnerTimeclockStagingConfig(e).issues.includes('owner_https_origin_rpid'));
});
test('synthetic staff test login and PIN bootstrap never run within HC Secure Owner runtime',()=>{
 const e=fixture();e.HC_STAGING_TEST_LOGIN_ENABLED='true';
 assert.ok(validateOwnerTimeclockStagingConfig(e).issues.includes('synthetic_login_disabled'));
 e.HC_STAGING_TEST_LOGIN_ENABLED='false';e.HC_STAGING_PIN_SETUP_ENABLED='true';
 assert.ok(validateOwnerTimeclockStagingConfig(e).issues.includes('synthetic_login_disabled'));
});
test('no shared default database or unexpected owner database name',()=>{
 const e=fixture();e.DATABASE_URL=e.HC_OWNER_STAGING_DATABASE_URL;
 assert.throws(()=>validateOwnerStagingDatabaseUrl(e),/Do not reuse/);
 e.DATABASE_URL='';e.HC_OWNER_STAGING_DATABASE_URL=e.HC_OWNER_STAGING_DATABASE_URL.replace('/hc_owner_stage_test','/railway');
 assert.throws(()=>validateOwnerStagingDatabaseUrl(e),/Dedicated hc_owner_stage_test/);
});
test('Owner runtime requires independent signing secrets and encryption key',()=>{
 const e=fixture();
 e.HC_OWNER_SESSION_SECRET=e.HC_OWNER_PASSKEY_SIGNING_SECRET;
 assert.ok(validateOwnerTimeclockStagingConfig(e).issues.includes('independent_security_secrets'));
 e.HC_OWNER_SESSION_SECRET='session-private-secret-value-1234567890';
 e.HC_OWNER_TOTP_ENCRYPTION_KEY=Buffer.alloc(16,9).toString('base64');
 assert.ok(validateOwnerTimeclockStagingConfig(e).issues.includes('HC_OWNER_TOTP_ENCRYPTION_KEY'));
});
