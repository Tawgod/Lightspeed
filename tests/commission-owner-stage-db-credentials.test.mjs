import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkCredentialScope} from '../scripts/commission-owner-stage-db-credentials.mjs';
const pass=i=>String.fromCharCode(65+i).repeat(48);
const valid=()=>({
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',HC_OWNER_DB_PROVISION_ONLY:'true',HC_OWNER_CREDENTIAL_COMMISSION_ONLY:'true',
 RAILWAY_PROJECT_ID:'5b46096d-3178-47ec-ba88-d5037696346a',RAILWAY_ENVIRONMENT_ID:'46b93c76-3085-4e76-a37d-90dfdd250dd2',
 RAILWAY_SERVICE_NAME:'hc-owner-db-bootstrap',
 HC_OWNER_BOOTSTRAP_DATABASE_URL:'postgresql://postgres:'+pass(0)+'@postgres-x8ui.railway.internal:5432/railway',
 HC_OWNER_DB_RUNTIME_PASSWORD:pass(1),HC_OWNER_DB_OPERATOR_PASSWORD:pass(2),
 HC_OWNER_SESSION_SECRET:pass(3),HC_OWNER_THROTTLE_SECRET:pass(4),
 HC_OWNER_PASSKEY_SIGNING_SECRET:pass(5),HC_OWNER_APPROVAL_HMAC_SECRET:pass(6),
 HC_OWNER_MFA_SESSION_SECRET:pass(7),HC_OWNER_TOTP_ENCRYPTION_KEY:'A'.repeat(43)+'='
});
test('staging credentials only; no duplicated or unresolved variables and no Owner',()=>{
 assert.equal(checkCredentialScope(valid()).pathname,'/railway');
 for(const c of [
  {NODE_ENV:'production'},{HC_SECURITY_ENV:'production'},
  {HC_OWNER_CREDENTIAL_COMMISSION_ONLY:'false'},{HC_OWNER_ROLE_PREPARE_ONLY:'true'},
  {HC_OWNER_STAGING_ENABLED:'true'},{HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'42'},
  {HC_OWNER_DB_RUNTIME_PASSWORD:'unresolved_function'},
  {HC_OWNER_DB_OPERATOR_PASSWORD:pass(1)},
  {HC_OWNER_SESSION_SECRET:pass(2)},
  {HC_OWNER_TOTP_ENCRYPTION_KEY:'A'.repeat(44)},
  {RAILWAY_PROJECT_ID:'production'},
  {HC_OWNER_BOOTSTRAP_DATABASE_URL:'postgresql://postgres:bad@external.net/railway'}
 ])assert.throws(()=>checkCredentialScope({...valid(),...c}));
});
test('SCRAM + real role privilege validation and wrong-password denial, rollback to NULL on failure',()=>{
 const s=readFileSync(new URL('../scripts/commission-owner-stage-db-credentials.mjs',import.meta.url),'utf8');
 for(const x of ['SCRAM-SHA-256','verifyOwnerStagingDatabasePrivileges','not-a-valid-generated-password',
  'PASSWORD NULL',"hc_first_owner_activations"])assert.ok(s.includes(x));
 assert.doesNotMatch(s,/console\.log\([^)]*PASSWORD/i);
});
