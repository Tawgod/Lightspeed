import express from 'express';

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
  const app = createSecurityStagingApp({ environment, mountSecurity });
  const port = Number(environment.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid staging PORT.');
  }
  return app.listen(port, '0.0.0.0');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  startSecurityStaging();
}
