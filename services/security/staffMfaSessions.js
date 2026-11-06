import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Server-only short-lived MFA step-up bound to an existing signed, active
// Timeclock employee session. A TOTP response by itself is NOT authentication.
// Candidate only: no production route is mounted, no cookies are issued.
const EMPLOYEE = /^[1-9][0-9]{0,17}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bad = () => Object.assign(new Error('Employee MFA verification required.'), {
  status: 401, code: 'HC_MFA_REQUIRED'
});
const unavailable = () => Object.assign(new Error('Employee MFA service unavailable.'), {
  status: 503, code: 'HC_MFA_UNAVAILABLE'
});
export function createStaffMfaSessions({
  secret, totp, verifyBaseSession, now = () => Date.now(),
  ttlSeconds = 300
} = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 ||
      typeof totp?.verifyCode !== 'function' ||
      typeof totp?.getActiveGeneration !== 'function' ||
      typeof verifyBaseSession !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 300) {
    throw new TypeError('Separate signing key, verified base sessions, active factor lookup and short TTL required.');
  }
  const mac = value => createHmac('sha256', secret).update(value).digest('base64url');
  async function base(context) {
    try {
      const verified = await verifyBaseSession(context);
      if (verified?.active !== true || !EMPLOYEE.test(String(verified.employeeId || '')) ||
          typeof verified.binding !== 'string' ||
          !/^[A-Za-z0-9_.:-]{16,256}$/.test(verified.binding)) throw bad();
      return {
        employeeId: String(verified.employeeId),
        bindingHash: mac('hc:staff:base-session:' + verified.binding)
      };
    } catch { throw bad(); }
  }
  function timestamp() {
    const n = now();
    if (!Number.isSafeInteger(n) || n < 0) throw unavailable();
    return n;
  }
  async function generation(context) {
    try {
      const value = await totp.getActiveGeneration({ context });
      return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
    } catch { throw unavailable(); }
  }
  const pack = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  const validToken = token => typeof token === 'string' && token.length < 1400 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

  async function authenticate({ context, code, sourceIp } = {}) {
    const identity = await base(context);
    const proof = await totp.verifyCode({ context, code, sourceIp }); // performs durable throttle + replay
    const acceptedAt = timestamp();
    if (proof?.verified !== true || proof.method !== 'totp' ||
        String(proof.employeeId) !== identity.employeeId ||
        !Number.isSafeInteger(proof.authenticatedAtMs) ||
        proof.authenticatedAtMs > acceptedAt ||
        proof.authenticatedAtMs < acceptedAt - 10000) throw bad();
    const factor = await generation(context);
    if (!factor) throw bad();
    const issuedAt = Math.floor(acceptedAt / 1000);
    const payload = pack({
      v: 1, aud: 'hc:staff:tools', purpose: 'routine-mfa',
      sub: identity.employeeId, sid: identity.bindingHash,
      fg: factor, amr: 'totp',
      authTime: acceptedAt, iat: issuedAt, exp: issuedAt + ttlSeconds,
      jti: randomBytes(16).toString('hex')
    });
    return Object.freeze({ token: payload + '.' + mac(payload), expiresIn: ttlSeconds });
  }

  async function verify({ context, token } = {}) {
    const identity = await base(context);
    if (!validToken(token)) throw bad();
    const [body, signature] = token.split('.');
    const expected = mac(body);
    if (signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw bad();
    let claims;
    try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { throw bad(); }
    const t = timestamp();
    const current = Math.floor(t / 1000);
    if (claims?.v !== 1 || claims?.aud !== 'hc:staff:tools' ||
        claims?.purpose !== 'routine-mfa' || claims?.sub !== identity.employeeId ||
        claims?.sid !== identity.bindingHash || claims?.amr !== 'totp' ||
        !UUID.test(String(claims?.fg || '')) ||
        !Number.isSafeInteger(claims?.iat) || claims.iat > current ||
        !Number.isSafeInteger(claims?.exp) ||
        claims.exp <= current || claims.exp > claims.iat + ttlSeconds ||
        !Number.isSafeInteger(claims?.authTime) ||
        claims.authTime > t || claims.authTime <= t - 5 * 60_000 ||
        typeof claims?.jti !== 'string' || !/^[a-f0-9]{32}$/.test(claims.jti)) throw bad();
    const active = await generation(context);
    if (!active || active !== claims.fg.toLowerCase()) throw bad();
    return Object.freeze({
      verified: true, employeeId: identity.employeeId,
      method: 'totp', authenticatedAtMs: claims.authTime
    });
  }
  return Object.freeze({ authenticate, verify });
}
