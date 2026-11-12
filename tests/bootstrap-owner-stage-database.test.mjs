import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkOwnerBootstrapScope,OWNER_STAGE_FIXTURES}
 from '../scripts/bootstrap-owner-stage-database.mjs';
const valid=()=>({
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_OWNER_DB_PROVISION_ONLY:'true',
 RAILWAY_PROJECT_ID:'5b46096d-3178-47ec-ba88-d5037696346a',
 RAILWAY_ENVIRONMENT_ID:'46b93c76-3085-4e76-a37d-90dfdd250dd2',
 RAILWAY_SERVICE_NAME:'hc-owner-db-bootstrap',
 HC_OWNER_BOOTSTRAP_DATABASE_URL:
 'postgresql://postgres:'+('x'.repeat(36))+'@postgres-x8ui.railway.internal:5432/railway'
});
test('bootstrap cannot target production, client-side Owner roles or any external database',()=>{
 assert.equal(checkOwnerBootstrapScope(valid()).pathname,'/railway');
 const cases=[
 {NODE_ENV:'production'},{HC_SECURITY_ENV:'production'},
 {HC_OWNER_DB_PROVISION_ONLY:'false'},
 {RAILWAY_PROJECT_ID:'f7e91de7-43f6-472e-b4ca-46b0623f8e0e'},
 {RAILWAY_ENVIRONMENT_ID:'c562fbb2-8431-4beb-834d-6938b3a2ad10'},
 {RAILWAY_SERVICE_NAME:'hc-foundation-pr63'},
 {HC_OWNER_STAGING_ENABLED:'true'},
 {OWNER_STAGING_IDENTITY_ENABLED:'true'},
 {HC_STAGING_TEST_LOGIN_ENABLED:'true'},
 {OWNER_STAGING_SERVICE_SECRET:'test'},
 {LIGHTSPEED_TOKEN:'real'},
 {HC_OWNER_BOOTSTRAP_DATABASE_URL:'postgresql://postgres:pass@prod.example.com/railway'},
 {HC_OWNER_BOOTSTRAP_DATABASE_URL:'postgresql://postgres:'+('x'.repeat(36))+'@postgres-x8ui.railway.internal/production'},
 {HC_OWNER_BOOTSTRAP_DATABASE_URL:'postgresql://other:'+('x'.repeat(36))+'@postgres-x8ui.railway.internal/railway'},
 {HC_OWNER_BOOTSTRAP_DATABASE_URL:''}
 ];
 for(const change of cases)assert.throws(()=>checkOwnerBootstrapScope({...valid(),...change}),
  /bootstrap refused/i,JSON.stringify(change));
});
test('bootstrap uses only the seven independently reviewed Owner staging SQL files',()=>{
 assert.deepEqual(OWNER_STAGE_FIXTURES,[
  'db/hc_admin_delegations.sql','db/hc_staff_passkeys.sql',
  'db/hc_staff_auth_throttle.sql','db/hc_staff_factor_approvals.sql',
  'db/hc_staff_totp.sql','db/hc_first_owner_operator_activation.sql',
  'db/hc_owner_staging_privilege_groups.sql'
 ]);
 for(const path of OWNER_STAGE_FIXTURES)
  assert.ok(readFileSync(new URL('../'+path,import.meta.url),'utf8').length>300,path);
 const source=readFileSync(new URL('../scripts/bootstrap-owner-stage-database.mjs',import.meta.url),'utf8');
 assert.match(source,/ROL[E]?/i); // ensure SQL role isolation is explicitly handled
 assert.match(source,/CREATE DATABASE/);
 assert.match(source,/REVOKE ALL ON DATABASE/);
 assert.match(source,/assertEmpty/);
 assert.match(source,/assertLeastPrivilege/);
 assert.doesNotMatch(source,/CREATE ROLE .* LOGIN PASSWORD/);
 assert.doesNotMatch(source,/OWNER_STAGING_EMPLOYEE_ID\s*=/);
});
