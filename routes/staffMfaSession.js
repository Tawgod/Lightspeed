import express from 'express';

// Unmounted: the hosting service must provide an existing signed Timeclock
// employee session verifier, a durable TOTP verifier and an MFA signing key.
// No PIN-only session can create a second-factor claim without a valid code.
export function createStaffMfaSessionRouter({ mfa } = {}) {
  if (typeof mfa?.authenticate !== 'function' || typeof mfa?.verify !== 'function') {
    throw new TypeError('Trusted MFA verifier required.');
  }
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store, max-age=0',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    });
    next();
  });
  router.post('/session', express.json({ limit: '1kb', strict: true }), async (req, res) => {
    if (!req.body || Object.keys(req.body).length !== 1 ||
        typeof req.body.code !== 'string' || !/^\d{6}$/.test(req.body.code)) {
      return res.status(400).json({ error: 'Enter a six-digit authenticator code.' });
    }
    try {
      const result = await mfa.authenticate({
        context: req, code: req.body.code,
        sourceIp: req.ip // requires verified proxy configuration before mounting
      });
      return res.json({ token: result.token, expiresIn: result.expiresIn, method: 'totp' });
    } catch (error) {
      const status = error?.status === 503 ? 503 : error?.status === 429 ? 429 : 401;
      return res.status(status).json({ error:
        status === 503 ? 'Authenticator service unavailable.' :
        status === 429 ? 'Too many attempts.' : 'Authenticator verification failed.'
      });
    }
  });
  router.get('/session', async (req, res) => {
    try {
      const token = req.get('x-hc-mfa-session');
      const proof = await mfa.verify({ context: req, token });
      return res.json({
        verified: true, method: proof.method,
        authenticatedAtMs: proof.authenticatedAtMs
      });
    } catch (error) {
      return res.status(error?.status === 503 ? 503 : 401).json({
        error: 'Authenticator session unavailable or expired.'
      });
    }
  });
  return router;
}
