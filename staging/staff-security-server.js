import express from 'express';
import pg from 'pg';
import {createIsolatedTestLoginMount} from './isolated-test-login.js';

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
    if(typeof environment.DATABASE_URL!=='string'||!environment.DATABASE_URL.startsWith('postgresql://'))
      throw new Error('Staging test login needs isolated PostgreSQL URL.');
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

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  startSecurityStaging();
}
