import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkLockedRoleEnvironment} from '../scripts/prepare-owner-locked-login-roles.mjs';
const valid=()=>({
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',HC_OWNER_DB_PROVISION_ONLY:'true',
 HC_OWNER_ROLE_PREPARE_ONLY:'true',
 RAILWAY_PROJECT_ID:'5b46096d-3178-47ec-ba88-d5037696346a',
 RAILWAY_ENVIRONMENT_ID:'46b93c76-3085-4e76-a37d-90dfdd250dd2',
 RAILWAY_SERVICE_NAME:'hc-owner-db-bootstrap',
 HC_OWNER_BOOTSTRAP_DATABASE_URL:'postgresql://postgres:'+('x'.repeat(40))+'@postgres-x8ui.railway.internal:5432/railway'
});
test('locked login role preparation cannot target production or activate Owner identity',()=>{
 assert.equal(checkLockedRoleEnvironment(valid()).pathname,'/railway');
 for(const change of [
  {NODE_ENV:'production'},{HC_SECURITY_ENV:'production'},
  {HC_OWNER_ROLE_PREPARE_ONLY:'false'},{HC_OWNER_STAGING_ENABLED:'true'},
  {HC_OWNER_OPERATOR_ACK:'I_VERIFIED_EMPLOYEE_ACCOUNT'},
  {HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'42'},
  {HC_OWNER_OPERATOR_DATABASE_URL:'postgres://secret'},
  {HC_OWNER_STAGING_DATABASE_URL:'postgres://secret'},
  {HC_OWNER_TIMECLOCK_SERVICE_SECRET:'bad'},
  {RAILWAY_PROJECT_ID:'production'},
  {HC_OWNER_BOOTSTRAP_DATABASE_URL:'postgresql://postgres:x@prod.example.net/railway'}
 ])assert.throws(()=>checkLockedRoleEnvironment({...valid(),...change}));
});
test('two independent locked LOGIN principals have no passwords or inherited crossover privileges',()=>{
 const s=readFileSync(new URL('../scripts/prepare-owner-locked-login-roles.mjs',import.meta.url),'utf8');
 assert.equal((s.match(/LOGIN PASSWORD NULL/g)||[]).length,2);
 assert.match(s,/pg_authid/);assert.match(s,/pg_has_role/);
 assert.match(s,/HC_OWNER_LOCKED_LOGINS_OK/);
 assert.match(s,/previous\.rowCount!==0/);
 assert.match(s,/owners!==0\|\|counts\.rows\[0\]\.activations!==0/);
 assert.doesNotMatch(s,/ALTER ROLE .*PASSWORD/);
});
