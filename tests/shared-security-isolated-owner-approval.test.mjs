import test from 'node:test';
import assert from 'node:assert/strict';
import {createIsolatedOwnerApprovalPolicy} from '../staging/isolated-owner-approval-policy.js';
const ORIGIN='https://staff-security-staging-test.up.railway.app',NOW=Date.parse('2026-11-05T18:00:00Z');
const env={
  NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
  HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
  HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
  HC_STAGING_PUBLIC_ORIGIN:ORIGIN,HC_STAGING_PIN_STORE_MODE:'database',
  HC_STAGING_PIN_SETUP_ENABLED:'false',HC_STAGING_OWNER_PASSKEY_ENABLED:'true'
};
const proof=()=>({
  verified:true,method:'passkey',active:true,id:'901',employeeId:'901',
  authenticatedAtMs:NOW-1000
});
const ctx=(headers={})=>({get:name=>({
  origin:ORIGIN,'sec-fetch-site':'same-origin',...headers
})[name.toLowerCase()]||null});
const action={context:ctx(),approverId:'901',employeeId:'901',operation:'staff.authenticator.enroll'};
const create=(extra={})=>createIsolatedOwnerApprovalPolicy({
  environment:env,verifyOwnerPasskey:async()=>proof(),now:()=>NOW,...extra
});
test('staging Owner permission requires exact owner, guild, test host and real passkey verification',()=>{
  assert.ok(create());
  for(const change of [
    {NODE_ENV:'production'},{HC_SECURITY_ENV:'production'},
    {HC_STAGING_TEST_OWNER_DISCORD_ID:'215626919134887940'},
    {HC_STAGING_TEST_GUILD_ID:'2485804234753573066'},
    {HC_STAGING_PUBLIC_ORIGIN:'https://evil.example'},
    {HC_STAGING_PIN_STORE_MODE:'legacy-env'},
    {HC_STAGING_PIN_SETUP_ENABLED:'true'},
    {HC_STAGING_OWNER_PASSKEY_ENABLED:'false'}
  ])assert.throws(()=>create({environment:{...env,...change}}));
  assert.throws(()=>create({verifyOwnerPasskey:null}));
});
test('exact test-only Authenticator approval requires fresh, signed, independent passkey proof',async()=>{
  const policy=create();
  assert.equal(await policy.canApproveEnrollment(action),true);
  for(const mutation of [
    {approverId:'902'},{employeeId:'902'},
    {operation:'staff.authenticator.invite'},
    {operation:'staff.passkey.revoke'},
    {operation:'staff.authenticator.recover'},
    {context:ctx({origin:'https://evil.example'})},
    {context:ctx({'sec-fetch-site':'cross-site'})}
  ])assert.equal(await policy.canApproveEnrollment({...action,...mutation}),false);
  assert.equal(await policy.canRecoverFactor(),false);
  assert.equal(await policy.canResetFactor(),false);
});
test('PIN-only, unverifiable, forged or expired manager proofs cannot approve',async()=>{
  for(const fake of [
    {verified:false}, {verified:true,method:'pin'}, {verified:true,method:'totp'},
    {verified:true,method:'passkey',active:false},
    {verified:true,method:'passkey',id:'902'},
    {verified:true,method:'passkey',employeeId:'902'},
    {verified:true,method:'passkey',authenticatedAtMs:NOW-300000},
    {verified:true,method:'passkey',authenticatedAtMs:NOW+1000},
    {verified:true,method:'passkey',authenticatedAtMs:'forged'}
  ]){
    const policy=create({verifyOwnerPasskey:async()=>({...proof(),...fake})});
    assert.equal(await policy.canApproveEnrollment(action),false,JSON.stringify(fake));
  }
  const unverified=create({verifyOwnerPasskey:async()=>{throw Error('No passkey proof')}});
  assert.equal(await unverified.canApproveEnrollment(action),false);
});
