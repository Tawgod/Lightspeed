import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bwipjs from 'bwip-js';

// DEVELOPMENT CANDIDATE ONLY: this router is deliberately NOT mounted in server.js.
// It is safe to mount only after verified workstation/passkey enrollment policy,
// trusted Timeclock employee lookup, CSRF/session review, database migration,
// key custody and real store/mobile acceptance are approved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicAssets = Object.freeze({
  '/': { file: 'staff-security.html', type: 'text/html; charset=utf-8' },
  '/client.js': { file: 'staff-security-client.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'staff-security.css', type: 'text/css; charset=utf-8' }
});
const deny = () => Object.assign(new Error('Employee security settings require additional verification.'), {
  status: 403
});
const noCache = (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY'
  });
  next();
};
const statusOf = error => [400, 401, 403, 409, 429, 503].includes(error?.status) ? error.status : 503;
const errorResponse = (res, error) => {
  const status = statusOf(error);
  res.status(status).json({ error:
    status === 401 ? 'Please sign in again.' :
    status === 403 ? 'Additional employee verification is required.' :
    status === 409 ? 'A setup request is already in progress.' :
    status === 429 ? 'Too many attempts. Please try later.' :
    status === 400 ? 'Invalid setup request.' :
    'Security settings are unavailable.' });
};
const validEmployee = employee => employee?.active === true &&
  /^[1-9][0-9]{0,17}$/.test(String(employee.id || ''));

export function createStaffSecuritySettingsRouter({
  verifyEmployee, authorizeSettings, totp, approvals
} = {}) {
  if (typeof verifyEmployee !== 'function' || typeof authorizeSettings !== 'function' ||
      typeof totp?.status !== 'function' ||
      typeof totp?.beginEnrollment !== 'function' ||
      typeof totp?.confirmEnrollment !== 'function' ||
      ['request','status','approve'].some(name => typeof approvals?.[name] !== 'function')) {
    throw new TypeError('A verified staff identity, independent setup authorization, and TOTP adapter are required.');
  }
  const router = express.Router();
  router.use(noCache);

  // The page and assets contain no employee data or secrets. Don't assume that
  // serving HTML authenticates; all API routes independently enforce policy.
  router.get(['/', '/client.js', '/styles.css'], async (req, res) => {
    const asset = publicAssets[req.path];
    if (!asset) return res.sendStatus(404);
    try {
      const bytes = await readFile(path.join(root, asset.file));
      res.type(asset.type);
      if (req.path === '/') {
        // No remote JS/fonts/images, inline scripts or framing. QR is generated
        // locally on the backend and displayed via a data: PNG.
        res.set('Content-Security-Policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
          "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      }
      res.send(bytes);
    } catch { res.sendStatus(503); }
  });

  async function guard(req, action) {
    let employee;
    try { employee = await verifyEmployee(req); }
    catch { throw deny(); }
    if (!validEmployee(employee)) throw deny();
    let accepted = false;
    try { accepted = await authorizeSettings({ request: req, employee: Object.freeze({
      id: String(employee.id), active: true
    }), action }) === true; }
    catch { /* denied */ }
    if (!accepted) throw deny();
  }

  async function authenticatedEmployee(req) {
    let employee;
    try { employee = await verifyEmployee(req); }
    catch { throw deny(); }
    if (!validEmployee(employee)) throw deny();
    return employee;
  }

  // A PIN-signed employee session may REQUEST manager approval. It cannot
  // create a seed or approve itself. Requests are tightly rate-limited and
  // bound by the backend to this precise signed employee session.
  router.get('/api/enrollment-request', async (req, res) => {
    try {
      await authenticatedEmployee(req);
      return res.json(await approvals.status({ context: req }));
    } catch (error) { return errorResponse(res, error); }
  });
  router.post('/api/enrollment-request', express.json({ limit: '1kb', strict: true }),
    async (req, res) => {
      try {
        if (!req.body || Object.keys(req.body).length !== 0)
          return res.status(400).json({ error: 'Invalid setup request.' });
        await authenticatedEmployee(req);
        return res.status(201).json(await approvals.request({ context: req, sourceIp: req.ip }));
      } catch (error) { return errorResponse(res, error); }
    });
  // No manager PIN grants here. The injected backend approver MUST validate an
  // employee-bound passkey/security-key/managed-IdP MFA before approving.
  router.post('/api/enrollment-approve', express.json({ limit: '1kb', strict: true }),
    async (req, res) => {
      try {
        if (!req.body || Object.keys(req.body).length !== 1 ||
            typeof req.body.requestId !== 'string' ||
            !/^[a-fA-F0-9-]{36}$/.test(req.body.requestId)) {
          return res.status(400).json({ error: 'Invalid approval request.' });
        }
        const approved = await approvals.approve({ context: req, requestId: req.body.requestId });
        return res.json({ approved: approved.approved === true });
      } catch (error) { return errorResponse(res, error); }
    });

  router.get('/api/authenticator', async (req, res) => {
    try {
      await guard(req, 'authenticator.status');
      const data = await totp.status({ context: req });
      if (!['not_enrolled', 'pending', 'active'].includes(data?.state)) throw Error('Invalid factor state');
      return res.json({
        state: data.state,
        ...(data.state === 'pending' ? { expiresAtMs: data.expiresAtMs } : {})
      });
    } catch (error) { return errorResponse(res, error); }
  });

  router.post('/api/authenticator/enroll', express.json({ limit: '1kb', strict: true }),
    async (req, res) => {
      try {
        // No client-supplied employee ID, role, PIN, approval, or secret accepted.
        if (!req.body || Object.keys(req.body).length !== 0) return res.status(400).json({
          error: 'Invalid setup request.'
        });
        await guard(req, 'authenticator.enroll');
        const enrollment = await totp.beginEnrollment({ context: req });
        const uri = new URL(enrollment.provisioningUri);
        if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' ||
            !/^[A-Z2-7]{32}$/.test(uri.searchParams.get('secret') || '')) throw Error('Invalid enrollment response.');
        // QR generation is local; no third-party QR service receives the secret.
        let qrDataUrl = null;
        try {
          const png = await bwipjs.toBuffer({ bcid: 'qrcode', text: enrollment.provisioningUri,
            scale: 4, padding: 4 });
          if (png.length <= 120000) qrDataUrl = 'data:image/png;base64,' + png.toString('base64');
        } catch { /* Manual secret entry remains supported. */ }
        return res.json({
          qrDataUrl,
          manualKey: uri.searchParams.get('secret'),
          expiresAtMs: enrollment.expiresAtMs
        });
      } catch (error) { return errorResponse(res, error); }
    });

  router.post('/api/authenticator/confirm', express.json({ limit: '1kb', strict: true }),
    async (req, res) => {
      try {
        if (!req.body || Object.keys(req.body).length !== 1 ||
            typeof req.body.code !== 'string' || !/^\d{6}$/.test(req.body.code)) {
          return res.status(400).json({ error: 'Enter a six-digit code.' });
        }
        await guard(req, 'authenticator.confirm');
        const result = await totp.confirmEnrollment({ context: req, code: req.body.code });
        if (result?.confirmed !== true) throw Error('Invalid confirmation.');
        return res.json({ confirmed: true });
      } catch (error) {
        if (error?.code === 'HC_TOTP_INVALID') {
          return res.status(401).json({ error: 'Code not accepted. Check your phone time and try again.' });
        }
        return errorResponse(res, error);
      }
    });
  return router;
}
