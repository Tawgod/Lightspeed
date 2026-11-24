import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyHcSecureCredentialCommissioningScope as validate}
 from '../services/security/hcSecureCredentialCommissioningPreflight.js';
const env=()=>({
 RAILWAY_PROJECT_ID:'120de974-f2e8-46be-9a00-8eb8b1be4cc4',
 RAILWAY_ENVIRONMENT_ID:'8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c',
 RAILWAY_SERVICE_NAME:'hc-secure-db-bootstrap-once',
 HC_SECURE_CREDENTIAL_COMMISSION_ONLY:'true',
 HC_SECURE_DB_MUTATION_APPROVED:'HC_SECURE_CREDENTIALS_ONLY',
 HC_SECURE_BOOTSTRAP_ROOT_URL:
  'postgresql://postgres:'+ 'A'.repeat(48) + '@hc-secure-postgres-staging.railway.internal:5432/railway',
 HC_SECURE_DB_RUNTIME_PASSWORD:'B'.repeat(48),
 HC_SECURE_DB_OPERATOR_PASSWORD:'C'.repeat(48)
});
test('accepts only independent new-project passwords and returns no secrets',()=>{
 const a=validate(env());
 assert.equal(a.ready,true);
 assert.equal(a.independentPasswords,true);
 assert.equal(JSON.stringify(a).includes('A'.repeat(48)),false);
 assert.equal(JSON.stringify(a).includes('B'.repeat(48)),false);
 assert.equal(JSON.stringify(a).includes('C'.repeat(48)),false);
});
test('rejects old Owner or shared business environments',()=>{
 for(const v of [
  {RAILWAY_PROJECT_ID:'5b46096d-3178-47ec-ba88-d5037696346a'},
  {RAILWAY_ENVIRONMENT_ID:'46b93c76-3085-4e76-a37d-90dfdd250dd2'},
  {RAILWAY_SERVICE_NAME:'hc-secure-auth-staging'},
  {HC_OWNER_STAGING_ENABLED:'true'},
  {DATABASE_URL:'postgresql://unsafe'},
  {HC_OWNER_STAGING_DATABASE_URL:'postgresql://unsafe'},
  {HC_OWNER_DB_RUNTIME_PASSWORD:'OLD_OWNER_SECRET'},
  {LIGHTSPEED_TOKEN:'any'},
  {TIMECLOCK_ADMIN_SECRET:'any'},
  {HC_SECURE_DB_BOOTSTRAP_ONLY:'true'},
  {HC_SECURE_ROLE_PREPARE_ONLY:'true'}
 ])assert.throws(()=>validate({...env(),...v}),/blocked/);
});
test('requires distinct operator action and exact new private database host',()=>{
 for(const v of [
  {HC_SECURE_CREDENTIAL_COMMISSION_ONLY:'false'},
  {HC_SECURE_DB_MUTATION_APPROVED:'HC_SECURE_FRESH_DB_SCHEMA_ONLY'},
  {HC_SECURE_BOOTSTRAP_ROOT_URL:'postgresql://postgres:'+ 'A'.repeat(48)+'@Postgres-x8Ui.railway.internal:5432/railway'},
  {HC_SECURE_BOOTSTRAP_ROOT_URL:'postgresql://postgres:'+ 'A'.repeat(48)+'@hc-secure-postgres-staging.railway.internal:5432/hc_owner_stage_test'}
 ])assert.throws(()=>validate({...env(),...v}),/blocked/);
});
test('rejects reused, missing, malformed and short role passwords',()=>{
 for(const v of [
  {HC_SECURE_DB_RUNTIME_PASSWORD:'C'.repeat(48)},
  {HC_SECURE_DB_OPERATOR_PASSWORD:'A'.repeat(48)},
  {HC_SECURE_DB_RUNTIME_PASSWORD:'B'.repeat(12)},
  {HC_SECURE_DB_OPERATOR_PASSWORD:'!'.repeat(48)},
  {HC_SECURE_DB_RUNTIME_PASSWORD:''}
 ])assert.throws(()=>validate({...env(),...v}),/blocked/);
});
