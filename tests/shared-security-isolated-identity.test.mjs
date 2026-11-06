import test from 'node:test';
import assert from 'node:assert/strict';
import {hashIsolatedTestPin,createIsolatedTestIdentity} from '../staging/isolated-test-identity.js';

const env={
 NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
 HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
 HC_STAGING_TEST_GUILD_ID:'1485804234753573066'
};
const digest=hashIsolatedTestPin('6047',Buffer.alloc(16,9));
test('synthetic identity rejects production, missing trust boundary and plaintext PIN',()=>{
 for(const delta of [
  {NODE_ENV:'production'}, {HC_SECURITY_ENV:'production'},
  {HC_STAGING_TEST_OWNER_DISCORD_ID:'215626919134887940'},
  {HC_STAGING_TEST_GUILD_ID:'2485804234753573066'}
 ]) assert.throws(()=>createIsolatedTestIdentity({environment:{...env,...delta},passwordHash:digest}));
 for(const bad of ['6047','scrypt:bad','',undefined]){
  assert.throws(()=>createIsolatedTestIdentity({environment:env,passwordHash:bad}));
 }
 assert.throws(()=>hashIsolatedTestPin('12345',Buffer.alloc(16)));
 assert.throws(()=>hashIsolatedTestPin('1234',Buffer.alloc(8)));
});
test('synthetic identity verifies PIN hash, exact account and operation, never manager proof',async()=>{
 const identity=createIsolatedTestIdentity({environment:env,passwordHash:digest});
 assert.equal((await identity.verifyPin('6047')).id,'901');
 for(const bad of ['0000','6048','a047','604','60470'])await assert.rejects(identity.verifyPin(bad));
 assert.equal((await identity.authorize('901')).permissionSource,'synthetic_staging_only');
 await assert.rejects(identity.authorize('902'));
 assert.equal(await identity.resolveDiscordEmployee('215626919134887940'),null);
 assert.deepEqual(await identity.resolveDiscordEmployee('115626919134887940'),
  {id:'901',discordUserId:'115626919134887940',active:true});
 const args={approverId:'901',employeeId:'901',actorDiscordId:'115626919134887940',
 targetDiscordId:'115626919134887940',guildId:'1485804234753573066',
 operation:'staff.authenticator.invite'};
 assert.equal(await identity.canInvite(args),true);
 for(const delta of [
 {approverId:'902'}, {employeeId:'902'}, {actorDiscordId:'215626919134887940'},
 {targetDiscordId:'215626919134887940'}, {guildId:'2485804234753573066'},
 {operation:'staff.authenticator.enroll'}
 ])assert.equal(await identity.canInvite({...args,...delta}),false);
 assert.equal('verifyStrongManager' in identity,false);
 assert.equal('canApproveEnrollment' in identity,false);
});
