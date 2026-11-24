import test from 'node:test';
import assert from 'node:assert/strict';
import {hcSecureStagingGate} from '../services/security/hcSecureStagingGate.js';

function valid(){
 return {
  NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
  HC_OWNER_STAGING_ENABLED:'true',HC_OWNER_TIMECLOCK_EMPLOYEE_ID:'1',
  HC_OWNER_STAGING_ORIGIN:'https://secure-hc.timcorp-productions.com',
  HC_OWNER_STAGING_RPID:'secure-hc.timcorp-productions.com',
  HC_STAGING_TEST_LOGIN_ENABLED:'false',HC_STAGING_PIN_SETUP_ENABLED:'false',
  RAILWAY_PROJECT_ID:'120de974-f2e8-46be-9a00-8eb8b1be4cc4',
  RAILWAY_ENVIRONMENT_ID:'8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c',
  HC_OWNER_STAGING_DATABASE_URL:'postgresql://runtime:fixture-only@hc-secure-postgres-staging.railway.internal:5432/hc_owner_stage_test',
  HC_OWNER_TIMECLOCK_ORIGIN:'https://canonical-timeclock.example.test'
 };
}
test('valid config passes without inspecting secrets or connecting to real services',()=>{
 assert.deepEqual(hcSecureStagingGate(valid()),{ready:true,issues:[]});
});
test('wrong Railway project/environment fail closed',()=>{
 for(const k of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID']){
  const v=valid();v[k]='not-the-approved-environment';
  assert.equal(hcSecureStagingGate(v).ready,false,k);
  assert.ok(hcSecureStagingGate(v).issues.includes(k),k);
 }
});
test('only approved WebAuthn relying party and origin',()=>{
 for(const [k,value] of [
  ['HC_OWNER_STAGING_ORIGIN','https://hc-owner-staging-staging.up.railway.app'],
  ['HC_OWNER_STAGING_RPID','hc-owner-staging-staging.up.railway.app'],
  ['HC_OWNER_STAGING_ORIGIN','http://secure-hc.timcorp-productions.com']
 ]){
  const v=valid();v[k]=value;
  assert.equal(hcSecureStagingGate(v).ready,false,k);
 }
});
test('old production/Owner and any public database URLs rejected',()=>{
 for(const url of [
  'postgresql://runtime:fixture-only@original-db.railway.internal/hc_owner_stage_test',
  'postgresql://runtime:fixture-only@hc-secure-postgres-staging.railway.internal/railway',
  'postgresql://runtime:fixture-only@hc-secure-postgres-staging.railway.internal/hc_owner_stage_test?sslmode=disable',
  'postgresql://runtime@hc-secure-postgres-staging.railway.internal/hc_owner_stage_test',
  'postgresql://runtime:fixture-only@public-host.example.com/hc_owner_stage_test'
 ]){
  const v=valid();v.HC_OWNER_STAGING_DATABASE_URL=url;
  assert.ok(hcSecureStagingGate(v).issues.includes('dedicated_private_runtime_database'));
 }
});
test('synthetic identity, live integration secrets and mismatched Owner are denied',()=>{
 for(const [k,value] of [
  ['HC_STAGING_TEST_LOGIN_ENABLED','true'],
  ['HC_STAGING_PIN_SETUP_ENABLED','true'],
  ['HC_OWNER_TIMECLOCK_EMPLOYEE_ID','901'],
  ['DATABASE_URL','postgresql://do-not-use.example.test'],
  ['LIGHTSPEED_TOKEN','never-copy'],
  ['SCANNER_SESSION_SECRET','never-copy'],
  ['TIMECLOCK_ADMIN_SECRET','never-copy']
 ]){
  const v=valid();v[k]=value;
  assert.equal(hcSecureStagingGate(v).ready,false,k);
 }
});
test('canonical Timeclock must be secure and separate',()=>{
 for(const host of ['http://timeclock.example.com','https://secure-hc.timcorp-productions.com','']){
  const v=valid();v.HC_OWNER_TIMECLOCK_ORIGIN=host;
  assert.equal(hcSecureStagingGate(v).ready,false,host);
 }
});
