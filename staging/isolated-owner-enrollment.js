import {createStaffSecuritySubsystem} from '../services/security/staffSecuritySubsystem.js';
import {createIsolatedOwnerApprovalPolicy} from './isolated-owner-approval-policy.js';

// Compose ONLY the existing invitation/approval/TOTP services for synthetic
// employee 901 in the isolated Railway test project. No production Timeclock,
// staff roles, factor recovery/reset, or API credential reuse is permitted.
const OWNER='115626919134887940';
const GUILD='1485804234753573066';
const CHANNEL='1566905099429744700';
const ORIGIN='https://staff-security-staging-test.up.railway.app';
const secrets=[
  'HC_STAGING_SESSION_SECRET',
  'HC_STAGING_THROTTLE_SECRET',
  'HC_STAGING_PASSKEY_SIGNING_SECRET',
  'HC_STAGING_APPROVAL_HMAC_SECRET',
  'HC_STAGING_MFA_SESSION_SECRET',
  'HC_STAGING_INVITE_BOT_SECRET',
  'HC_STAGING_INVITE_TOKEN_SECRET'
];
export function assertIsolatedOwnerEnrollmentConfiguration(environment=process.env){
 if(environment.NODE_ENV!=='test'||
    environment.HC_SECURITY_ENV!=='isolated-staging'||
    environment.HC_STAGING_TEST_OWNER_DISCORD_ID!==OWNER||
    environment.HC_STAGING_TEST_GUILD_ID!==GUILD||
    environment.HC_STAGING_PUBLIC_ORIGIN!==ORIGIN||
    environment.HC_STAGING_PIN_STORE_MODE!=='database'||
    environment.HC_STAGING_PIN_SETUP_ENABLED!=='false'||
    environment.HC_STAGING_TEST_LOGIN_ENABLED!=='true'||
    environment.HC_STAGING_OWNER_PASSKEY_ENABLED!=='true'||
    environment.HC_STAGING_OWNER_BOOTSTRAP_ENABLED!=='false'||
    (environment.HC_STAGING_OWNER_BOOTSTRAP_KEY||'')!==''||
    environment.HC_STAGING_OWNER_APPROVAL_ENABLED!=='true'||
    environment.HC_STAGING_OWNER_ENROLLMENT_ENABLED!=='true')
  throw new Error('Isolated synthetic Owner authenticator enrollment is disabled.');
 for(const name of secrets){
   if(typeof environment[name]!=='string'||environment[name].length<32)
     throw new Error('Isolated enrollment requires separate strong service secrets.');
 }
 if(new Set(secrets.map(n=>environment[n])).size!==secrets.length)
   throw new Error('Isolated enrollment secrets must be independently generated.');
 if(!/^[A-Za-z0-9+/]{43}=$/.test(environment.HC_STAGING_TOTP_ENCRYPTION_KEY||'')||
    Buffer.from(environment.HC_STAGING_TOTP_ENCRYPTION_KEY,'base64').length!==32)
   throw new Error('Isolated TOTP requires a separate 256-bit AES-GCM key.');
 return true;
}
export function createIsolatedOwnerEnrollmentMount({
  environment=process.env,pool,staffAuthGateway,identity,passkeys
}={}){
 assertIsolatedOwnerEnrollmentConfiguration(environment);
 if(typeof pool?.connect!=='function'||
    typeof staffAuthGateway?.verifyBoundEmployee!=='function'||
    typeof identity?.resolveDiscordEmployee!=='function'||
    typeof identity?.canInvite!=='function'||
    typeof passkeys?.verifyStrongManager!=='function')
   throw new TypeError('Trusted signed test session, active synthetic employee and WebAuthn verifier required.');
 const policy=createIsolatedOwnerApprovalPolicy({
   environment,verifyOwnerPasskey:passkeys.verifyStrongManager
 });
 const subsystem=createStaffSecuritySubsystem({
   staffAuthGateway,pool,
   totpEncryptionKey:environment.HC_STAGING_TOTP_ENCRYPTION_KEY,
   throttleHmacSecret:environment.HC_STAGING_THROTTLE_SECRET,
   approvalHmacSecret:environment.HC_STAGING_APPROVAL_HMAC_SECRET,
   mfaSessionSecret:environment.HC_STAGING_MFA_SESSION_SECRET,
   verifyStrongManager:passkeys.verifyStrongManager,
   canApproveEnrollment:policy.canApproveEnrollment,
   canRecoverFactor:policy.canRecoverFactor,
   enrollmentInvitations:{
     environment,
     botSecret:environment.HC_STAGING_INVITE_BOT_SECRET,
     tokenSecret:environment.HC_STAGING_INVITE_TOKEN_SECRET,
     guildId:GUILD,setupOrigin:ORIGIN,
     ownerOnlyTest:{environment:'isolated-staging',ownerDiscordId:OWNER,channelId:CHANNEL},
     resolveDiscordEmployee:identity.resolveDiscordEmployee,
     canInvite:identity.canInvite
   }
 });
 if(typeof subsystem?.settingsRouter!=='function'||
    typeof subsystem?.invitationRouter!=='function')
   throw new TypeError('Expected verified test-only settings and invitation routers.');
 return Object.freeze({
   settingsRouter:subsystem.settingsRouter,
   invitationRouter:subsystem.invitationRouter
 });
}
