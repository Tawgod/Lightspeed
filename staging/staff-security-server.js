import express from 'express';
import pg from 'pg';
import {createIsolatedTestLoginMount} from './isolated-test-login.js';
import {assertIsolatedOwnerEnrollmentConfiguration} from './isolated-owner-enrollment.js';
import {assertIsolatedTestDatabase,migrateIsolatedTestLogin} from './migrate-isolated-test-login.js';

// Isolated Railway staging entrypoint. Does not import server.js, mount
// operational Lightspeed APIs, or create a demo staff identity.
export function createSecurityStagingApp({
  environment = process.env, mountSecurity = null
} = {}) {
  if (environment.HC_SECURITY_ENV !== 'isolated-staging' ||
      environment.NODE_ENV !== 'test') {
    throw new Error('Refusing to start outside isolated security staging.');
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    });
    next();
  });
  app.get('/health', (_req, res) => res.json({
    service: 'hobby-corner-staff-security-staging',
    ready: typeof mountSecurity === 'function'
  }));
  if (typeof mountSecurity === 'function') {
    // Only an audited trusted-adapter composition may wire login and
    // factor endpoints. No PIN or Discord-role bypass.
    mountSecurity(app);
  } else {
    app.use((_req, res) => res.status(503).json({
      error: 'Staff security onboarding has not been activated.'
    }));
  }
  return app;
}

export function startSecurityStaging({
  environment = process.env, mountSecurity = null
} = {}) {
  let activePool = null;
  if(environment.HC_STAGING_TEST_LOGIN_ENABLED==='true') {
    if(mountSecurity!==null)throw new Error('Cannot override active test PIN composition.');
    assertIsolatedTestDatabase(environment);
    activePool=new pg.Pool({
      connectionString:environment.DATABASE_URL,
      max:4,
      connectionTimeoutMillis:3000,
      idleTimeoutMillis:10000
    });
    try {
      mountSecurity=createIsolatedTestLoginMount({environment,pool:activePool}).mount;
    } catch(e){void activePool.end();throw e;}
  }
  const app = createSecurityStagingApp({ environment, mountSecurity });
  const port = Number(environment.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid staging PORT.');
  }
  const server=app.listen(port, '0.0.0.0');
  if(activePool)server.on('close',()=>{void activePool.end();});
  return server;
}

// For Railway startup only: establish the schema before opening the health
// endpoint. A fresh test PostgreSQL deployment may become ready shortly after
// the API container, so retry transient DB readiness; never open login early.
export async function launchSecurityStaging({
  environment=process.env, migrate=migrateIsolatedTestLogin,
  start=startSecurityStaging, pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}) {
  if(environment.HC_STAGING_TEST_LOGIN_ENABLED==='true'){
    assertIsolatedTestDatabase(environment);
    // New factor migrations must never begin with incomplete or shared
    // secrets. The existing synthetic test PIN remains usable if disabled.
    if(environment.HC_STAGING_OWNER_ENROLLMENT_ENABLED==='true')
      assertIsolatedOwnerEnrollmentConfiguration(environment);
    // Validate the separate Owner bootstrap prerequisites before creating
    // any expiring database grant, not after the staging API starts.
    if(environment.HC_STAGING_OWNER_BOOTSTRAP_ENABLED==='true'&&
       environment.HC_STAGING_OWNER_PASSKEY_ENABLED!=='true')
      throw new Error('Owner bootstrap requires an enabled passkey verifier.');
    if(environment.HC_STAGING_OWNER_PASSKEY_ENABLED==='true'){
      if(environment.HC_STAGING_PIN_STORE_MODE!=='database'||
         environment.HC_STAGING_PIN_SETUP_ENABLED!=='false'||
         environment.HC_STAGING_PUBLIC_ORIGIN!=='https://staff-security-staging-test.up.railway.app'||
         typeof environment.HC_STAGING_PASSKEY_SIGNING_SECRET!=='string'||
         environment.HC_STAGING_PASSKEY_SIGNING_SECRET.length<32||
         (environment.HC_STAGING_OWNER_BOOTSTRAP_ENABLED==='true'&&
          !/^[A-Za-z0-9_-]{43,256}$/.test(environment.HC_STAGING_OWNER_BOOTSTRAP_KEY||'')))
        throw new Error('Invalid isolated Owner passkey prerequisites.');
    }
    let ready=false;
    for(let attempt=0;attempt<20;attempt++){
      try {await migrate({environment});ready=true;break;}
      catch {
        if(attempt===19)break;
        await pause(3000);
      }
    }
    if(!ready)throw new Error('Isolated test database migration could not become ready.');
  }
  return start({environment});
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  launchSecurityStaging().catch(()=>{
    console.error('Isolated security test service startup failed.');
    process.exitCode=1;
  });
}
