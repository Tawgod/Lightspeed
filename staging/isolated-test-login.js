import {fileURLToPath} from 'node:url';
import {createStaffAuthGateway} from '../services/staffAuthGateway.js';
import {createPostgresStaffLoginThrottle} from '../services/security/staffLoginThrottle.js';
import {createIsolatedTestIdentity} from './isolated-test-identity.js';
import {createIsolatedPinSetup} from './isolated-pin-setup.js';
import {createPostgresStaffPasskeys} from '../services/security/staffPasskeysPostgres.js';
import {createStaffPasskeyRouter} from '../routes/staffPasskey.js';
import {createIsolatedFirstOwnerPasskeyGrant} from './isolated-owner-passkey-grant.js';
import {createIsolatedOwnerEnrollmentMount} from './isolated-owner-enrollment.js';
import {createIsolatedAdminReadonlyMount} from './isolated-admin-readonly.js';

// Explicitly mounts ONLY signed PIN sessions. Not invitations, manager
// approvals, TOTP QR seeds, or production Lightspeed/Timeclock routes.
export function createIsolatedTestLoginMount({
  environment=process.env,pool
}={}){
  if(environment.HC_STAGING_TEST_LOGIN_ENABLED!=='true')
    throw new Error('Staging PIN login is not enabled.');
  if(environment.NODE_ENV!=='test'||environment.HC_SECURITY_ENV!=='isolated-staging'||
     typeof pool?.connect!=='function')
    throw new Error('Staging login requires isolated runtime and durable PostgreSQL.');
  for(const name of ['HC_STAGING_SESSION_SECRET','HC_STAGING_THROTTLE_SECRET']){
    if(typeof environment[name]!=='string'||environment[name].length<32)
      throw new Error('Staging login missing a separate strong service secret.');
  }
  // PIN storage is independent of the one-time setup route. Disabling
  // setup must never revert login to the obsolete environment PIN hash.
  const storeMode=environment.HC_STAGING_PIN_STORE_MODE||'legacy-env';
  if(!['legacy-env','database'].includes(storeMode))
    throw new Error('Unknown isolated PIN storage mode.');
  if(environment.HC_STAGING_PIN_SETUP_ENABLED==='true'&&storeMode==='legacy-env')
    throw new Error('One-time PIN setup requires database-backed storage.');
  const setup=storeMode==='database'
    ?createIsolatedPinSetup({environment,pool}):null;
  const identity=createIsolatedTestIdentity({
    environment, ...(setup?{readPinHash:setup.pinHash}:{})
  });
  const throttle=createPostgresStaffLoginThrottle({
    pool,secret:environment.HC_STAGING_THROTTLE_SECRET,
    scope:'hc:isolated-test:pin'
  });
  const gateway=createStaffAuthGateway({
    identity,sessionSecret:environment.HC_STAGING_SESSION_SECRET,
    loginLimiter:({ip})=>throttle.reserve({employeeId:'901',sourceIp:ip})
  });
  // First-Owner passkey is separately gated and does not mount any TOTP,
  // invitation, or recovery endpoints. PIN alone cannot register the passkey.
  let passkeys=null;
  if(environment.HC_STAGING_OWNER_BOOTSTRAP_ENABLED==='true'&&
     environment.HC_STAGING_OWNER_PASSKEY_ENABLED!=='true')
    throw new Error('First Owner bootstrap cannot run without the passkey verifier.');
  if(environment.HC_STAGING_OWNER_PASSKEY_ENABLED==='true'){
    const signingSecret=environment.HC_STAGING_PASSKEY_SIGNING_SECRET;
    if(typeof signingSecret!=='string'||signingSecret.length<32)
      throw new Error('Independent staging passkey signing secret required.');
    const bootstrapOpen=environment.HC_STAGING_OWNER_BOOTSTRAP_ENABLED==='true';
    // Once the first passkey is registered, operators may permanently retire
    // the high-entropy bootstrap key/flag while preserving passkey verification.
    const grant=bootstrapOpen
      ?createIsolatedFirstOwnerPasskeyGrant({
         environment,pool,verifyBoundEmployee:gateway.verifyBoundEmployee
       }):null;
    const passkeyThrottle=createPostgresStaffLoginThrottle({
      pool,secret:environment.HC_STAGING_THROTTLE_SECRET,
      scope:'hc:isolated-test:owner-passkey'
    });
    passkeys=createPostgresStaffPasskeys({
      pool,origin:environment.HC_STAGING_PUBLIC_ORIGIN,
      rpID:'staff-security-staging-test.up.railway.app',signingSecret,
      verifyBoundEmployee:gateway.verifyBoundEmployee,
      authorizeRegistration:grant?grant.authorizeRegistration:async()=>false,
      commitRegistrationGrant:grant?grant.commitRegistrationGrant:async()=>{
        throw new Error('Owner bootstrap is permanently closed.');
      },
      verifyStrongManager:async()=>{throw new Error('No factor recovery bootstrap');},
      canManage:async()=>false,
      loginThrottle:passkeyThrottle
    });
  }
  // Explicit third-stage opt-in. Registering a passkey must NOT silently
  // expose invitation issuance, Authenticator seeds or manager approvals.
  let enrollment=null;
  if(environment.HC_STAGING_OWNER_ENROLLMENT_ENABLED==='true'){
    if(!passkeys)throw new Error('Independent Owner WebAuthn must precede enrollment.');
    enrollment=createIsolatedOwnerEnrollmentMount({
      environment,pool,staffAuthGateway:gateway,identity,passkeys
    });
  }
  // Optional isolated read-only admin preview; never appoints a real Owner,
  // runs admin migrations, or mounts employee/tool mutation endpoints.
  let adminPreview=null;
  if(environment.HC_STAGING_ADMIN_READONLY_ENABLED==='true'){
    if(!passkeys||!enrollment)throw new Error('Staging admin requires independent passkey and enrolled TOTP.');
    adminPreview=createIsolatedAdminReadonlyMount({
      environment,gateway,passkeys,enrollment
    });
  }
  function mount(app){
    // Staging-only, same-origin browser sign-in. No local/session storage
    // and no client-side authorization of enrollment or approvals.
    for(const [route,file,type] of [
      ['/test-login','test-login.html','html'],
      ['/test-login.js','test-login.js','application/javascript'],
      ['/test-login.css','test-login.css','text/css']
    ]){
      app.get(route,(_req,res)=>{
        res.set({
          'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
          'Cache-Control':'no-store, max-age=0'
        });
        res.type(type).sendFile(fileURLToPath(new URL('./'+file,import.meta.url)));
      });
    }
    if(setup?.enabled){
      for(const [route,file,type] of [
        ['/test-pin-setup','test-pin-setup.html','html'],
        ['/test-pin-setup.js','test-pin-setup.js','application/javascript']
      ])app.get(route,(_req,res)=>{
        res.set({
          'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
          'Cache-Control':'no-store, max-age=0'
        });
        res.type(type).sendFile(fileURLToPath(new URL('./'+file,import.meta.url)));
      });
      app.use('/api/test-pin-setup',setup.router);
    }
    if(passkeys){
      app.get('/test-owner-passkey',(_req,res)=>{
        res.set({
          'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
          'Cache-Control':'no-store, max-age=0'
        });
        const page=environment.HC_STAGING_OWNER_BOOTSTRAP_ENABLED==='true'
          ?'./test-owner-passkey.html'
          :enrollment?'./test-owner-passkey-approve.html'
          :'./test-owner-passkey-verify.html';
        res.type('html').sendFile(fileURLToPath(new URL(page,import.meta.url)));
      });
      app.use('/staff-passkey',createStaffPasskeyRouter({passkeys}));
    }
    if(enrollment){
      // Explicit, test-only adapter for the settings page's existing auth UI.
      // Never mount this route in production or when enrollment is disabled.
      app.get('/shared-ui/staff-auth.js',(_req,res)=>{
        res.set({
          'Content-Security-Policy':"default-src 'none'",
          'Cache-Control':'no-store, max-age=0',
          'X-Content-Type-Options':'nosniff'
        });
        res.type('application/javascript').sendFile(
          fileURLToPath(new URL('./isolated-staff-auth-client.js',import.meta.url))
        );
      });
      app.use('/staff-security',enrollment.settingsRouter);
      app.use('/staff-enrollment-invites',enrollment.invitationRouter);
    }
    if(adminPreview){
      app.get('/employee-admin/auth.js',(_req,res)=>{
        res.set({
          'Content-Security-Policy':"default-src 'none'",
          'Cache-Control':'no-store, max-age=0',
          'X-Content-Type-Options':'nosniff'
        });
        res.type('application/javascript').sendFile(
          fileURLToPath(new URL('./isolated-admin-auth-client.js',import.meta.url))
        );
      });
      // This router is read-only and has no mutation adapter.
      app.use('/employee-admin',adminPreview.router);
    }
    app.use('/api/staff-auth',gateway.router);
    app.use((_req,res)=>res.status(503).json({
      error:'Authenticator enrollment is not yet enabled in isolated staging.'
    }));
  }
  return Object.freeze({mount,gateway,identity});
}
