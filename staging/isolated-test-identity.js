import {scryptSync, timingSafeEqual} from 'node:crypto';

// Synthetic identity for the isolated security test environment.
// Never queries or accepts an ID from the production Timeclock.
// This identity can sign in and REQUEST enrollment, but it cannot authorize
// independent manager approval or recovery.
const OWNER = '115626919134887940';
const GUILD = '1485804234753573066';
const EMPLOYEE = '901';
const HASH = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/;
const forbidden = () => Object.assign(new Error('Test employee authentication failed.'), {status:401});

export function createIsolatedTestIdentity({
  environment = process.env,
  passwordHash = environment.HC_STAGING_TEST_PIN_HASH
} = {}) {
  if (environment.NODE_ENV !== 'test' ||
      environment.HC_SECURITY_ENV !== 'isolated-staging' ||
      environment.HC_STAGING_TEST_OWNER_DISCORD_ID !== OWNER ||
      environment.HC_STAGING_TEST_GUILD_ID !== GUILD) {
    throw new Error('Isolated test employee identity refused outside authorized staging.');
  }
  const match=typeof passwordHash==='string' && HASH.exec(passwordHash);
  if(!match)throw new Error('An explicit scrypt-hashed synthetic test PIN is required.');
  const salt=Buffer.from(match[1],'hex'),expected=Buffer.from(match[2],'hex');
  const employee=Object.freeze({
    id:EMPLOYEE,name:'Staging Test Owner',role:'test-owner',
    permissionSource:'synthetic_staging_only',active:true
  });
  async function verifyPin(pin){
    if(typeof pin!=='string'||!/^\d{4}$/.test(pin))throw forbidden();
    const computed=scryptSync(pin,salt,64,{N:16384,r:8,p:1});
    if(!timingSafeEqual(computed,expected))throw forbidden();
    return employee;
  }
  async function authorize(id){
    if(String(id)!==EMPLOYEE)throw forbidden();
    return employee;
  }
  async function resolveDiscordEmployee(discordId){
    return discordId===OWNER ?
      Object.freeze({id:EMPLOYEE,discordUserId:OWNER,active:true}) : null;
  }
  async function canInvite({approverId,employeeId,actorDiscordId,targetDiscordId,guildId,operation}={}){
    return String(approverId)===EMPLOYEE && String(employeeId)===EMPLOYEE &&
      actorDiscordId===OWNER && targetDiscordId===OWNER &&
      guildId===GUILD && operation==='staff.authenticator.invite';
  }
  // Deliberately no manager proof here; first Owner's independent passkey
  // must be bootstrapped with a separate real WebAuthn verifier before approval.
  return Object.freeze({verifyPin,authorize,resolveDiscordEmployee,canInvite});
}

// Local helper for provisioning a non-production test PIN hash.
// Do not log the PIN or store the cleartext in Railway/GitHub.
export function hashIsolatedTestPin(pin,salt){
  if(typeof pin!=='string'||!/^\d{4}$/.test(pin) ||
     !(salt instanceof Uint8Array)||salt.length!==16)
    throw new TypeError('Four-digit synthetic PIN and random 16-byte salt required.');
  return 'scrypt:'+Buffer.from(salt).toString('hex')+':'+
    scryptSync(pin,salt,64,{N:16384,r:8,p:1}).toString('hex');
}
